// Many Words — emulator
// Implements the rules from GAME_DESIGN.md:
// - 6 scrambles (10 tiles each) drawn once at game start, all shown on one page
// - each rack has exactly two wildcard (blank) tiles, no more and no fewer
// - each scramble tracks only its BEST scoring guess so far
// - total score = sum of the 6 best scores, live-updated
// - min word length 3, standard Scrabble letter values, dictionary-checked
// - same word may be reused as best word across multiple scrambles
// - no time penalty for invalid or non-improving guesses
// - length bonus (+1 per letter past 5)
// - the game can be ended early at any time via the Stop Game button
// - no more than 2 of any identical real letter per scramble (wildcards
//   are exempt, and can still supply a 3rd+ copy of a letter in a guess)
// - naming: the focused, playable rack is scramble1; its guess field is
//   unscramble1. The other five (top to bottom in the sorted list) are
//   scramble2-6 — informational only, not directly playable. Clicking one
//   brings it into the scramble1 position.

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
let score = 0;
let secondsLeft = GAME_SECONDS;
let timerHandle = null;
let gameActive = false;
let activeIndex = 0;     // which scramble (scramble1) is currently focused/enlarged

const HISTORY_KEY = 'manyWordsHistory';

const el = (id) => document.getElementById(id);

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
  activeIndex = 0;

  el('game').classList.remove('hidden');
  el('game-over').classList.add('hidden');
  el('start-btn').textContent = 'Restart';
  el('stop-btn').classList.remove('hidden');
  updateScore();
  renderActive();
  renderOtherList();
  renderStatsPanel();
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

function renderTileEls(tilesDiv, tiles, { showPoints = true } = {}) {
  tilesDiv.innerHTML = '';
  tiles.forEach((t) => {
    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.dataset.pts = t.points;
    const letterHtml = `<span class="letter">${t.letter === '?' ? '?' : t.letter}</span>`;
    const ptsHtml = showPoints ? `<span class="pts">${t.points}</span>` : '';
    tile.innerHTML = letterHtml + ptsHtml;
    tilesDiv.appendChild(tile);
  });
}

// --- Per-scramble guess building (typing + click-to-build) ---
// A "ctx" bundles a scramble with the specific DOM elements currently
// driving it (rack tiles, guess mirror strip, and text input), so the same
// logic runs identically for the enlarged scramble1 (unscramble1) and every
// compact scramble2-6 row (unscramble2-6).

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

// Only scramble1 is ever played directly, so this always applies to the
// active scramble.
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

  el('active-best-word').textContent = word;
  el('active-best-word').classList.remove('empty');
  el('active-best-score').textContent = `${scramble.bestScore} pts`;

  const panel = el('active-panel');
  panel.classList.remove('just-improved');
  void panel.offsetWidth;
  panel.classList.add('just-improved');
}

// scramble1: big tiles, unscramble1, and its own best word/score. Uses a
// fixed set of DOM elements that persist across renders, so getActiveCtx()
// always looks up the CURRENT active scramble rather than closing over a
// stale one (important since these elements' event listeners are attached
// only once, at script load).
function getActiveCtx() {
  return {
    scramble: scrambles[activeIndex],
    tilesEl: el('active-tiles'),
    guessTilesEl: el('guess-tiles'),
    inputEl: el('active-guess-input'),
  };
}

function renderActive() {
  closeLetterMenu();
  const scramble = scrambles[activeIndex];
  renderTileEls(el('active-tiles'), scramble.displayTiles);
  const ctx = getActiveCtx();
  attachTileClickHandlers(ctx);

  const bestWordSpan = el('active-best-word');
  bestWordSpan.textContent = scramble.bestWord || 'no word yet';
  bestWordSpan.classList.toggle('empty', !scramble.bestWord);
  clearGuess(ctx);
}

// scramble2-6: informational only — rack tiles and best word/score, not
// interactive. Sorted by current best score, highest first. Click a row to
// bring that scramble into the scramble1 position, where it becomes
// playable via unscramble1.
function renderOtherList() {
  const container = el('other-scrambles');
  container.innerHTML = '';

  const others = scrambles
    .map((scramble, idx) => ({ scramble, idx }))
    .filter(({ idx }) => idx !== activeIndex)
    .sort((a, b) => b.scramble.bestScore - a.scramble.bestScore);

  others.forEach(({ scramble, idx }) => {
    const row = document.createElement('div');
    row.className = 'other-row';

    const tilesDiv = document.createElement('div');
    tilesDiv.className = 'tiles';
    renderTileEls(tilesDiv, scramble.displayTiles, { showPoints: false });

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

    row.appendChild(tilesDiv);
    row.appendChild(bestDiv);
    row.addEventListener('click', () => {
      clearGuess(getActiveCtx());
      activeIndex = idx;
      renderActive();
      renderOtherList();
    });

    container.appendChild(row);
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

el('active-guess-input').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  submitGuess(getActiveCtx());
});

el('active-guess-input').addEventListener('input', (e) => {
  const ctx = getActiveCtx();
  syncGuessOriginsToLength(ctx, e.target.value.length);
  renderGuessTiles(ctx);
});

el('active-shuffle-btn').addEventListener('click', () => {
  const scramble = scrambles[activeIndex];
  scramble.displayTiles = shuffleTiles(scramble.tiles);
  renderTileEls(el('active-tiles'), scramble.displayTiles);
  const ctx = getActiveCtx();
  attachTileClickHandlers(ctx);
  clearGuess(ctx);
});

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
}

el('start-btn').addEventListener('click', startGame);
el('play-again-btn').addEventListener('click', startGame);
