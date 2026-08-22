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

// Tile colors run in spectrum (wavelength) order — see the
// data-pts color rules in style.css: red(2) orange(3) tan(1) yellow(4)
// green(5) teal/wildcard(0) blue(10) purple(7), long wavelength to short.
const WAVELENGTH_RANK = { 2: 0, 3: 1, 1: 2, 4: 3, 5: 4, 0: 5, 10: 6, 7: 7 };

// Default display order: by tile color, arranged in spectrum order
// (matches WAVELENGTH_RANK) rather than by point value.
function defaultOrderTiles(tiles) {
  return [...tiles].sort((a, b) => WAVELENGTH_RANK[a.points] - WAVELENGTH_RANK[b.points]);
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

// --- Per-scramble guess building (typing + click-to-build) ---
// A "ctx" bundles a scramble with the specific DOM elements that drive it.
// Every scramble now gets its own permanent card (built once in
// renderAllScrambles), so — unlike the old single "active" slot — there's
// no need to reattach anything between renders.

// Mirrors the in-progress guess as plain text — no tile boxes, no color —
// one letter per span so each can still be double-clicked to remove it.
// This is the ONLY way a guess is built — there is no text entry,
// click-only. Also clears any leftover submit feedback ("Invalid word"
// etc.) since the guess is changing.
function renderGuessTiles(ctx) {
  ctx.feedbackEl.textContent = '';
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
// word, shows what it would score — updating with every click — without
// waiting for Submit. Shows nothing while the in-progress guess isn't a
// real word yet.
function updateLiveScore(ctx) {
  const word = ctx.guessValue.toUpperCase();
  const result = evaluateGuess(word, ctx.scramble.tiles);
  if (!result.valid) {
    ctx.liveScoreEl.textContent = '';
    return;
  }
  ctx.liveScoreEl.textContent = `${result.score} pts`;
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

function submitGuess(ctx) {
  const scramble = ctx.scramble;
  const word = ctx.guessValue.trim().toUpperCase();
  if (!word) return;
  const result = evaluateGuess(word, scramble.tiles);
  if (!result.valid) {
    ctx.feedbackEl.textContent = 'Invalid word';
    return;
  }
  if (result.score <= scramble.bestScore) {
    ctx.feedbackEl.textContent = "Doesn't beat your best score";
    return;
  }

  score += result.score - scramble.bestScore;
  scramble.bestWord = word;
  scramble.bestScore = result.score;
  updateScore();
  clearGuess(ctx);

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

    // One row: Shuffle, the rack (the scramble), Start Over, the word being
    // built (as plain text — no boxes/colors), its live point value, then
    // Submit at the far right.
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
    const submitBtn = document.createElement('button');
    submitBtn.type = 'button';
    submitBtn.className = 'submit-guess-btn';
    submitBtn.textContent = 'Submit';
    const feedbackSpan = document.createElement('span');
    feedbackSpan.className = 'submit-feedback';

    top.appendChild(shuffleBtn);
    top.appendChild(tilesDiv);
    top.appendChild(startOverBtn);
    top.appendChild(guessTilesDiv);
    top.appendChild(liveScoreSpan);
    top.appendChild(submitBtn);
    top.appendChild(feedbackSpan);
    card.appendChild(top);
    container.appendChild(card);

    const ctx = {
      scramble,
      tilesEl: tilesDiv,
      guessTilesEl: guessTilesDiv,
      guessValue: '',
      cardEl: card,
      feedbackEl: feedbackSpan,
      liveScoreEl: liveScoreSpan,
    };
    scrambleCtxs.push(ctx);

    renderTileEls(tilesDiv, scramble.displayTiles);
    attachTileClickHandlers(ctx);
    clearGuess(ctx);

    submitBtn.addEventListener('click', () => submitGuess(ctx));
    startOverBtn.addEventListener('click', () => clearGuess(ctx));
    shuffleBtn.addEventListener('click', () => {
      scramble.displayTiles = shuffleTiles(scramble.tiles);
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

  refreshGridIfVisible();
}

// --- Layout Edit mode ---
// Drags the game's OWN real rendered elements (real header controls, real
// tiles on whatever rack actually got dealt) rather than a separate mockup,
// so what you see while dragging is exactly what the game looks like.
// Only the first scramble's row is made draggable — all 6 share the same
// layout, so editing one is enough. Export Layout reads back each edited
// element's final on-screen position/size as plain text.
let layoutEditActive = false;
let layoutDragState = null;

function layoutEditTargets() {
  const targets = [];
  const stats = document.querySelectorAll('#top-bar .stat');
  targets.push({ name: 'Brand / title', el: document.querySelector('#top-bar .brand') });
  targets.push({ name: 'Score box', el: stats[0] });
  targets.push({ name: 'Timer box', el: stats[1] });
  targets.push({ name: 'Start Game button', el: el('start-btn') });
  targets.push({ name: 'Stop Game button', el: el('stop-btn') });
  targets.push({ name: 'Show Grid button', el: el('grid-toggle-btn') });

  scrambleCtxs.forEach((ctx, i) => {
    const n = i + 1;
    targets.push({ name: `Scramble ${n}: Shuffle button`, el: ctx.cardEl.querySelector('.row-shuffle-btn') });
    targets.push({ name: `Scramble ${n}: Rack tiles`, el: ctx.tilesEl });
    targets.push({ name: `Scramble ${n}: Guess tiles`, el: ctx.guessTilesEl });
    targets.push({ name: `Scramble ${n}: Live score`, el: ctx.liveScoreEl });
    targets.push({ name: `Scramble ${n}: Submit button`, el: ctx.cardEl.querySelector('.submit-guess-btn') });
    targets.push({ name: `Scramble ${n}: Start Over button`, el: ctx.cardEl.querySelector('.start-over-btn') });
  });

  targets.push({ name: 'Info block 1', el: el('info-block-1') });
  targets.push({ name: 'Info block 2', el: el('info-block-2') });
  targets.push({ name: 'Info block 3', el: el('info-block-3') });
  targets.push({ name: 'Info block 4', el: el('info-block-4') });

  return targets.filter((t) => t.el);
}

// Dragging doubles as selecting: a plain click (pointerdown+up with barely
// any movement) toggles the object in/out of a multi-select set instead of
// moving it. Dragging a SELECTED object moves every selected object
// together, by the same delta; dragging an unselected one moves just that
// one, same as before. DRAG_THRESHOLD tells a click apart from a drag.
const layoutSelected = new Set();
const DRAG_THRESHOLD = 4;

function layoutDragPointerDown(e) {
  const target = e.currentTarget;
  const participants = layoutSelected.has(target) ? Array.from(layoutSelected) : [target];
  const snapshot = new Map(participants.map((elm) => {
    const r = elm.getBoundingClientRect();
    return [elm, { left: r.left, top: r.top }];
  }));
  layoutDragState = { target, startX: e.clientX, startY: e.clientY, moved: false, snapshot };
  target.setPointerCapture(e.pointerId);
}

function layoutDragPointerMove(e) {
  if (!layoutDragState || layoutDragState.target !== e.currentTarget) return;
  const dx = e.clientX - layoutDragState.startX;
  const dy = e.clientY - layoutDragState.startY;
  if (!layoutDragState.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
    layoutDragState.moved = true;
    layoutDragState.snapshot.forEach((pos, elm) => elm.classList.add('dragging-layout'));
  }
  if (!layoutDragState.moved) return;
  layoutDragState.snapshot.forEach((pos, elm) => {
    elm.style.left = `${pos.left + dx}px`;
    elm.style.top = `${pos.top + dy}px`;
  });
}

function layoutDragPointerUp(e) {
  if (!layoutDragState || layoutDragState.target !== e.currentTarget) return;
  const state = layoutDragState;
  state.snapshot.forEach((pos, elm) => elm.classList.remove('dragging-layout'));
  if (!state.moved) {
    // A real click, not a drag: toggle this object's selection.
    if (layoutSelected.has(state.target)) {
      layoutSelected.delete(state.target);
      state.target.classList.remove('layout-selected');
    } else {
      layoutSelected.add(state.target);
      state.target.classList.add('layout-selected');
    }
  }
  layoutDragState = null;
}

function clearLayoutSelection() {
  layoutSelected.forEach((elm) => elm.classList.remove('layout-selected'));
  layoutSelected.clear();
}

// Rubber-band (marquee) selection — drag across empty space to select
// everything the box touches, like a drawing/design program. Replaces the
// current selection unless Shift is held (then it adds to it). Starting a
// marquee on empty space with no drag at all just clears the selection,
// same as clicking empty canvas in a drawing program.
let marqueeState = null;
let marqueeEl = null;

function isOnDraggable(target) {
  return target.closest && target.closest('.layout-draggable, .layout-resize-handle');
}

function marqueePointerDown(e) {
  if (!layoutEditActive || isOnDraggable(e.target)) return;
  if (!e.shiftKey) clearLayoutSelection();
  marqueeState = { startX: e.clientX, startY: e.clientY, rect: null };
  marqueeEl = document.createElement('div');
  marqueeEl.id = 'layout-marquee';
  document.body.appendChild(marqueeEl);
  updateMarqueeRect(e.clientX, e.clientY);
  document.addEventListener('pointermove', marqueePointerMove);
  document.addEventListener('pointerup', marqueePointerUp);
}

function updateMarqueeRect(curX, curY) {
  const x = Math.min(marqueeState.startX, curX);
  const y = Math.min(marqueeState.startY, curY);
  const w = Math.abs(curX - marqueeState.startX);
  const h = Math.abs(curY - marqueeState.startY);
  marqueeEl.style.left = `${x}px`;
  marqueeEl.style.top = `${y}px`;
  marqueeEl.style.width = `${w}px`;
  marqueeEl.style.height = `${h}px`;
  marqueeState.rect = { left: x, top: y, right: x + w, bottom: y + h };
}

function marqueePointerMove(e) {
  if (!marqueeState) return;
  updateMarqueeRect(e.clientX, e.clientY);
}

function marqueePointerUp() {
  if (!marqueeState) return;
  const m = marqueeState.rect;
  document.querySelectorAll('.layout-draggable').forEach((elm) => {
    const r = elm.getBoundingClientRect();
    const intersects = !(r.right < m.left || r.left > m.right || r.bottom < m.top || r.top > m.bottom);
    if (intersects) {
      layoutSelected.add(elm);
      elm.classList.add('layout-selected');
    }
  });
  marqueeEl.remove();
  marqueeEl = null;
  marqueeState = null;
  document.removeEventListener('pointermove', marqueePointerMove);
  document.removeEventListener('pointerup', marqueePointerUp);
}

// Resizing — three handles per object: a corner (stretches both width and
// height together), a right-edge handle (width only), and a bottom-edge
// handle (height only) — "stretch" in one direction without changing the
// other. Separate pointer capture from the move-drag handle, with
// stopPropagation so grabbing any resize handle never also starts a move
// or a selection click.
let layoutResizeState = null;
const LAYOUT_MIN_SIZE = 20;

function layoutResizePointerDown(e) {
  e.stopPropagation();
  const handle = e.currentTarget;
  const target = handle.parentElement;
  const rect = target.getBoundingClientRect();
  layoutResizeState = {
    target, mode: handle.dataset.resizeMode,
    startX: e.clientX, startY: e.clientY, startW: rect.width, startH: rect.height,
  };
  target.classList.add('dragging-layout');
  handle.setPointerCapture(e.pointerId);
}

// Resizing scales the object with a CSS transform rather than changing its
// box width/height directly — a plain width/height change on a tile row
// just gives it more empty space without the tiles themselves changing
// size. Scaling transforms everything inside proportionally (letters,
// colors, borders, font sizes, all of it), for every kind of object.
function layoutResizePointerMove(e) {
  if (!layoutResizeState || e.currentTarget.parentElement !== layoutResizeState.target) return;
  e.stopPropagation();
  const s = layoutResizeState;
  const target = s.target;
  const naturalW = parseFloat(target.dataset.naturalW);
  const naturalH = parseFloat(target.dataset.naturalH);
  let scaleX = parseFloat(target.dataset.scaleX || '1');
  let scaleY = parseFloat(target.dataset.scaleY || '1');
  if (s.mode !== 'height') {
    const w = Math.max(LAYOUT_MIN_SIZE, s.startW + (e.clientX - s.startX));
    scaleX = w / naturalW;
  }
  if (s.mode !== 'width') {
    const h = Math.max(LAYOUT_MIN_SIZE, s.startH + (e.clientY - s.startY));
    scaleY = h / naturalH;
  }
  target.dataset.scaleX = scaleX;
  target.dataset.scaleY = scaleY;
  target.style.transform = `scale(${scaleX}, ${scaleY})`;
}

function layoutResizePointerUp(e) {
  if (layoutResizeState && e.currentTarget.parentElement === layoutResizeState.target) {
    e.stopPropagation();
    layoutResizeState.target.classList.remove('dragging-layout');
    layoutResizeState = null;
  }
}

function enableLayoutEdit() {
  const targets = layoutEditTargets();
  // Measure every element's position FIRST, in one pass — pulling an
  // element out of flow (position:fixed) reflows everything after it, so
  // measuring-then-immediately-repositioning one at a time would corrupt
  // the measurements of whatever comes next.
  const measured = targets.map(({ name, el: target }) => ({ name, target, rect: target.getBoundingClientRect() }));
  measured.forEach(({ name, target, rect }) => {
    target.dataset.layoutName = name;
    target.dataset.naturalW = rect.width;
    target.dataset.naturalH = rect.height;
    target.dataset.scaleX = '1';
    target.dataset.scaleY = '1';
    target.classList.add('layout-draggable');
    target.style.position = 'fixed';
    target.style.left = `${rect.left}px`;
    target.style.top = `${rect.top}px`;
    target.style.width = `${rect.width}px`;
    target.style.height = `${rect.height}px`;
    target.style.margin = '0';
    target.style.zIndex = '500';
    target.style.transformOrigin = 'top left';
    target.addEventListener('pointerdown', layoutDragPointerDown);
    target.addEventListener('pointermove', layoutDragPointerMove);
    target.addEventListener('pointerup', layoutDragPointerUp);

    [
      ['both', 'layout-resize-handle corner'],
      ['width', 'layout-resize-handle edge-right'],
      ['height', 'layout-resize-handle edge-bottom'],
    ].forEach(([mode, className]) => {
      const handle = document.createElement('div');
      handle.className = className;
      handle.dataset.resizeMode = mode;
      handle.addEventListener('pointerdown', layoutResizePointerDown);
      handle.addEventListener('pointermove', layoutResizePointerMove);
      handle.addEventListener('pointerup', layoutResizePointerUp);
      target.appendChild(handle);
    });
  });
  document.addEventListener('pointerdown', marqueePointerDown);
  layoutEditActive = true;
  el('layout-edit-btn').textContent = 'Exit Layout Edit';
  el('layout-edit-note').classList.remove('hidden');
}

function disableLayoutEdit() {
  document.removeEventListener('pointerdown', marqueePointerDown);
  document.querySelectorAll('.layout-draggable').forEach((target) => {
    target.querySelectorAll('.layout-resize-handle').forEach((h) => h.remove());
    target.style.position = '';
    target.style.left = '';
    target.style.top = '';
    target.style.width = '';
    target.style.height = '';
    target.style.margin = '';
    target.style.zIndex = '';
    target.style.transform = '';
    target.style.transformOrigin = '';
    delete target.dataset.naturalW;
    delete target.dataset.naturalH;
    delete target.dataset.scaleX;
    delete target.dataset.scaleY;
    target.classList.remove('layout-draggable', 'dragging-layout', 'layout-selected');
    target.removeEventListener('pointerdown', layoutDragPointerDown);
    target.removeEventListener('pointermove', layoutDragPointerMove);
    target.removeEventListener('pointerup', layoutDragPointerUp);
  });
  clearLayoutSelection();
  layoutEditActive = false;
  el('layout-edit-btn').textContent = 'Edit Layout';
  el('layout-edit-note').classList.add('hidden');
  el('layout-export-panel').classList.add('hidden');
}

function exportLayout() {
  const lines = Array.from(document.querySelectorAll('.layout-draggable')).map((target) => {
    const r = target.getBoundingClientRect();
    return `${target.dataset.layoutName}: x=${Math.round(r.left)}, y=${Math.round(r.top)}, w=${Math.round(r.width)}, h=${Math.round(r.height)}`;
  });
  el('layout-export-text').value = lines.join('\n');
  el('layout-export-panel').classList.remove('hidden');
}

el('layout-edit-btn').addEventListener('click', () => {
  if (layoutEditActive) disableLayoutEdit();
  else enableLayoutEdit();
});
el('export-layout-btn').addEventListener('click', exportLayout);
el('clear-selection-btn').addEventListener('click', clearLayoutSelection);

el('start-btn').addEventListener('click', startGame);
el('play-again-btn').addEventListener('click', startGame);
el('grid-toggle-btn').addEventListener('click', toggleGrid);
window.addEventListener('resize', refreshGridIfVisible);
