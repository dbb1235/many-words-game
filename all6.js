// ALL6 — builds on Only One's mechanics (drag-and-drop tile rows,
// wildcards, 2L/3L bonus cells) but with 6 scrambles instead of 1, shown
// one pair of rows at a time to keep the screen uncluttered.
//
// Terminology: each scramble's top (rack) row is "tray N", its bottom
// (word-building) row is "guess N" — tray1/guess1 through tray6/guess6.
// Only the active pair is visible; the other 5 are dealt and kept in
// memory (their DOM just stays hidden) so their state survives switching
// away and back. A summary list shows guess1-6's current point totals
// plus their sum, and doubles as the way to switch which pair is shown —
// clicking "Guess 2" reveals tray2/guess2 and hides whatever was showing.

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

let scrambles = [];      // { tiles, displayTiles, isShuffled, bottomBonuses }
let scrambleCtxs = [];   // per-card DOM element bundle, parallel to `scrambles`
let activeScrambleIndex = 0; // which tray/guess pair is currently visible
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
      tiles,
      displayTiles: alphabeticalOrderTiles(tiles),
      isShuffled: false,
      // Rolled once per scramble and kept fixed for the rest of the game —
      // Shuffle resets that scramble's guess row's tiles but must not
      // re-roll these.
      bottomBonuses: rollBottomBonuses(RACK_SIZE),
    });
  }

  score = 0;
  secondsLeft = GAME_SECONDS;
  gameActive = true;
  activeScrambleIndex = 0;

  el('game').classList.remove('hidden');
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

// Each guess-row cell independently has an 8% chance of being a 2L bonus
// square; of whichever cells that leaves, each independently has a 4%
// chance of being 3L. Applied per-cell rather than picking a fixed count
// — so the number of bonus cells in any given row varies (could be zero,
// one of each, several, etc.).
const DOUBLE_LETTER_CHANCE = 0.08;
const TRIPLE_LETTER_CHANCE = 0.04;

// Rolls a fixed bonus layout (2L/3L/undefined per cell) once — called
// only at deal time (see startGame) so the layout stays put for the rest
// of the game; Shuffle must reuse it, never re-roll it.
function rollBottomBonuses(count) {
  return Array.from({ length: count }, () => {
    if (Math.random() < DOUBLE_LETTER_CHANCE) return '2L';
    if (Math.random() < TRIPLE_LETTER_CHANCE) return '3L';
    return undefined;
  });
}

// Same squares (same size/shape/color, driven by data-pts), but with no
// letter or point number inside — used for a guess row. Applies the
// scramble's already-fixed bonus layout (bonuses) — see
// rollBottomBonuses and renderBottomBonusLabel.
function renderBlankTileEls(tilesDiv, tiles, bonuses) {
  tilesDiv.innerHTML = '';
  tiles.forEach((t, i) => {
    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.dataset.pts = t.points;
    tilesDiv.appendChild(tile);

    if (bonuses[i]) tile.dataset.bonus = bonuses[i];
    renderBottomBonusLabel(tile);
  });
}

// Shows a guess-row cell's bonus label (2L/3L), same small font as the
// point numbers on the tray tiles. A no-op if the cell has no bonus.
function renderBottomBonusLabel(cellEl) {
  if (!cellEl.dataset.bonus) return;
  cellEl.innerHTML = '';
  const span = document.createElement('span');
  span.className = 'bottom-bonus-label';
  span.textContent = cellEl.dataset.bonus;
  cellEl.appendChild(span);
}

// Every tile in this game is white, regardless of point value. See also
// the tray-row override in all6.css.
const TILE_FILL_COLOR = '#fff';

// The tile element currently being dragged (tray tile or guess-row cell,
// from any scramble), so the drop handler can empty it out once its
// contents land somewhere else.
let dragSourceEl = null;

// Lets every tray tile be picked up and dragged (native HTML5 drag and
// drop) — the only interaction for a real letter tile. A wildcard also
// responds to a double-click, opening the same A-Z picker used in the
// guess row, so its letter can be previewed/chosen while still in the
// tray; a single click still does nothing.
function attachTileDragHandlers(ctx) {
  const tileEls = Array.from(ctx.tilesEl.children);
  tileEls.forEach((tileEl, i) => {
    const tile = ctx.topTiles[i];
    tileEl.draggable = true;
    tileEl.classList.add('clickable-letter'); // cursor/hover styling only
    tileEl.addEventListener('dragstart', (e) => {
      dragSourceEl = tileEl;
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('application/json', JSON.stringify(tile));
      // Dims the source tile for the duration of the drag so it reads as
      // "picked up" rather than duplicated — the browser's native drag
      // image already shows a copy following the cursor, so without this
      // the original sitting in place looks like a second, extra tile.
      tileEl.classList.add('tile-lifted');
    });
    tileEl.addEventListener('dragend', () => tileEl.classList.remove('tile-lifted'));

    if (tile.letter === '?') {
      tileEl.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        toggleTopWildcardMenu(ctx, tileEl, i);
      });
    }
  });
}

// Opens (or closes, if already open on this tile) the A-Z picker for a
// tray wildcard. Picking a letter updates just this tile's own entry in
// ctx.topTiles and re-renders the row — the tile still carries 0 points
// regardless of the letter shown, same as any other wildcard.
function toggleTopWildcardMenu(ctx, tileEl, index) {
  if (openMenuTile === tileEl) {
    closeLetterMenu();
    return;
  }
  openLetterMenu(ctx, tileEl, (letter) => {
    ctx.topTiles[index] = { letter, points: 0 };
    renderTopRow(ctx);
  });
}

// Rebuilds one scramble's tray row from ctx.topTiles (the tiles still
// remaining up there) and reattaches drag handlers. Used both for the
// initial render and after a tile is dragged out, so the remaining tiles
// always sit contiguous on the left with no gap left behind.
function renderTopRow(ctx) {
  renderTileEls(ctx.tilesEl, ctx.topTiles);
  attachTileDragHandlers(ctx);
}

// A wildcard (0 points) reverts to an unresolved '?' whenever it lands
// back in the tray — whatever letter was picked for it while it sat in
// the guess row only applied there, same as it never touched the
// underlying tile object for a tray wildcard in the first place.
function asTopRowTile(tile) {
  return tile.points === 0 ? { letter: '?', points: 0 } : tile;
}

// Makes one scramble's tray row itself (the container, not any one cell)
// a drop target, so a tile can be dragged back up from that scramble's
// own guess row. The tray compacts and has no fixed empty slots to
// return a tile to, so it always lands as a brand new cell appended to
// the end of the row. Attached once — the container element persists
// across renderTopRow calls, only its children get rebuilt.
function attachTopRowDropHandler(ctx) {
  ctx.tilesEl.addEventListener('dragover', (e) => {
    if (!dragSourceEl || dragSourceEl.parentElement !== ctx.tilesEl2) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  });

  ctx.tilesEl.addEventListener('drop', (e) => {
    if (!dragSourceEl || dragSourceEl.parentElement !== ctx.tilesEl2) return;
    e.preventDefault();
    const tile = JSON.parse(e.dataTransfer.getData('application/json'));
    ctx.topTiles.push(asTopRowTile(tile));
    vacateBottomCell(ctx, dragSourceEl);
    dragSourceEl = null;
    renderTopRow(ctx);
  });
}

// Puts a tile's letter/points/color into one of ctx's guess-row cells —
// used both for a fresh drop from that scramble's tray and for
// rearranging within its guess row.
function fillBottomCell(ctx, cellEl, tile) {
  cellEl.dataset.pts = tile.points;
  cellEl.dataset.letter = tile.letter;
  // The cell's own bonus (fixed at deal time, independent of whatever
  // tile passes through it) multiplies the DISPLAYED number only —
  // dataset.pts keeps the tile's true/original value, which is what
  // travels with it if it's dragged elsewhere.
  const displayPoints = tile.points * bonusMultiplierFor(cellEl);
  cellEl.innerHTML = `<span class="letter">${tile.letter === '?' ? '?' : tile.letter}</span><span class="pts">${displayPoints}</span>`;
  cellEl.style.setProperty('background', TILE_FILL_COLOR, 'important');
  cellEl.draggable = true;
  // Defensive: a cell being filled is never still mid-drag itself, so any
  // leftover dim-while-dragging state (see attachTileDragHandlers) can't
  // legitimately still apply here — clear it rather than risk it getting
  // stuck faded if a 'dragend' was ever missed.
  cellEl.classList.remove('tile-lifted');
  updateBottomWordScore(ctx);
}

// Clears one of ctx's guess-row cells back to vacant/white and
// un-draggable. If this cell is a bonus square, its 2L/3L label
// reappears now that nothing covers it — same as an uncovered bonus
// square on a Scrabble board.
function vacateBottomCell(ctx, cellEl) {
  cellEl.innerHTML = '';
  delete cellEl.dataset.letter;
  cellEl.style.setProperty('background', '#fff', 'important');
  cellEl.draggable = false;
  cellEl.classList.remove('tile-lifted');
  renderBottomBonusLabel(cellEl);
  updateBottomWordScore(ctx);
}

// A cell's bonus (2L/3L, see renderBottomBonusLabel) multiplies just that
// one letter's own point value — 2x or 3x — same as it stayed marked
// even while covered, so this applies whether or not the label is
// currently visible.
function bonusMultiplierFor(cellEl) {
  if (cellEl.dataset.bonus === '2L') return 2;
  if (cellEl.dataset.bonus === '3L') return 3;
  return 1;
}

// Reads ctx's guess row left to right (skipping vacant cells) as the
// current candidate word. If it's a valid dictionary word (min length 3),
// the score is the sum of each filled cell's point value — a wildcard
// cell is always worth 0, no matter what letter was chosen for it, since
// its dataset.pts never changes from 0. Otherwise the score is 0. Updates
// that guess's line in the summary list (showing the word itself in
// place of the "Guess N" label once one's been started, and the running
// total (see renderAllScrambles / updateGuessTotal) — there's no more
// per-row score display next to the tiles themselves, since the summary
// list already shows the same number for every guess at once.
function updateBottomWordScore(ctx) {
  if (!ctx) return;
  const filledCells = Array.from(ctx.tilesEl2.children).filter((c) => c.dataset.letter);
  const word = filledCells.map((c) => c.dataset.letter).join('').toUpperCase();
  const isValid = word.length >= MIN_WORD_LEN && WORD_LIST.has(word);
  const guessScore = isValid
    ? filledCells.reduce((sum, c) => sum + Number(c.dataset.pts) * bonusMultiplierFor(c), 0)
    : 0;
  ctx.guessScore = guessScore;
  if (ctx.summaryRowEl) {
    ctx.summaryRowEl.querySelector('.guess-summary-label').textContent = word || `Guess ${ctx.index + 1}`;
    ctx.summaryRowEl.querySelector('.guess-summary-score').textContent = guessScore;
  }
  updateGuessTotal();
}

// Sums every scramble's current guess score and mirrors it into the
// header/info-block Score display (the old running "best word" score
// this used to show is gone along with the click-to-build-guess
// mechanic it depended on). No longer shown as its own line in the
// summary list — just the header Score now.
function updateGuessTotal() {
  const total = scrambleCtxs.reduce((sum, ctx) => sum + (ctx.guessScore || 0), 0);
  score = total;
  updateScore();
}

// Wildcards always carry 0 points, no matter what letter has been chosen
// for them, so points === 0 is the durable "this cell is a wildcard" test
// — unlike checking for '?', it survives the letter being picked, and
// survives the tile being moved, swapped, or dragged back up top.
function isWildcardCell(cellEl) {
  return cellEl.dataset.letter !== undefined && cellEl.dataset.pts === '0';
}

// Opens the same A-Z pulldown used on tray wildcards, but picking a
// letter here just updates this guess-row cell's own displayed letter
// (still worth 0 points) rather than building a guess. Re-openable at any
// time to change the pick.
function toggleBottomWildcardMenu(ctx, cellEl) {
  if (openMenuTile === cellEl) {
    closeLetterMenu();
    return;
  }
  openLetterMenu(ctx, cellEl, (letter) => {
    cellEl.dataset.letter = letter;
    cellEl.innerHTML = `<span class="letter">${letter}</span><span class="pts">0</span>`;
    updateBottomWordScore(ctx);
  });
}

// Makes every cell in ctx's blank guess row both a drop target and (once
// filled) a drag source, so tiles can land there from that scramble's
// tray and then be freely rearranged among the guess row's own cells
// afterward. Dropping a tray tile always lands (overwriting whatever was
// there); dragging a guess-row tile onto a vacant cell moves it there,
// and onto an occupied cell swaps the two tiles' contents.
function attachBottomCellHandlers(ctx) {
  const cellEls = Array.from(ctx.tilesEl2.children);
  cellEls.forEach((cellEl) => {
    cellEl.draggable = false;

    // Wildcard cells (0 points) stay clickable to pick/re-pick their letter,
    // same as an unresolved '?' tile up in the tray.
    cellEl.addEventListener('click', (e) => {
      if (!isWildcardCell(cellEl)) return;
      e.stopPropagation();
      toggleBottomWildcardMenu(ctx, cellEl);
    });

    cellEl.addEventListener('dragstart', (e) => {
      if (!cellEl.dataset.letter) {
        e.preventDefault();
        return;
      }
      dragSourceEl = cellEl;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('application/json', JSON.stringify({
        letter: cellEl.dataset.letter,
        points: Number(cellEl.dataset.pts),
      }));
      // See attachTileDragHandlers — dims the source for the drag's
      // duration so it doesn't look like a second, extra tile next to the
      // browser's native drag-ghost image following the cursor.
      cellEl.classList.add('tile-lifted');
    });
    cellEl.addEventListener('dragend', () => cellEl.classList.remove('tile-lifted'));

    // dropEffect must match the source's effectAllowed ('copy' from the
    // tray, 'move' from within the guess row) or real browsers refuse the
    // drop outright — a mismatch here silently blocked every tray drag
    // once any guess-row rearrange had run.
    cellEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      const fromBottomRow = dragSourceEl && dragSourceEl.parentElement === ctx.tilesEl2;
      e.dataTransfer.dropEffect = fromBottomRow ? 'move' : 'copy';
    });

    cellEl.addEventListener('drop', (e) => {
      e.preventDefault();
      const fromBottomRow = dragSourceEl && dragSourceEl.parentElement === ctx.tilesEl2;
      const tile = JSON.parse(e.dataTransfer.getData('application/json'));

      // Whatever already occupied the target cell is displaced back up to
      // this scramble's tray (never lost, never swapped into the drag
      // source) — so wherever you dragged FROM always ends up blank,
      // whether that source was the tray or another guess-row cell.
      const displaced = cellEl.dataset.letter
        ? { letter: cellEl.dataset.letter, points: Number(cellEl.dataset.pts) }
        : null;

      fillBottomCell(ctx, cellEl, tile);

      let topRowChanged = false;
      if (dragSourceEl) {
        if (fromBottomRow) {
          vacateBottomCell(ctx, dragSourceEl);
        } else {
          // Tray tiles don't leave a gap — remove it from the list so the
          // rest slide left to close the space.
          const idx = Array.from(ctx.tilesEl.children).indexOf(dragSourceEl);
          if (idx !== -1) { ctx.topTiles.splice(idx, 1); topRowChanged = true; }
        }
        dragSourceEl = null;
      }

      if (displaced) {
        ctx.topTiles.push(asTopRowTile(displaced));
        topRowChanged = true;
      }

      if (topRowChanged) renderTopRow(ctx);
    });
  });
}

let openMenuTile = null;
let openMenuCtx = null;

// Pulldown of A-Z shown when a wildcard tile is clicked, so the player can
// pick which letter that blank should spell. onSelect(letter) decides what
// picking a letter actually does — a tray wildcard updates its own entry
// in ctx.topTiles, while a wildcard sitting in the guess row just updates
// its own displayed letter (see toggleBottomWildcardMenu above).
function openLetterMenu(ctx, tileEl, onSelect) {
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
      onSelect(letter);
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

// Shows only the active scramble's tray/guess pair; the other 5 stay
// dealt and rendered (so dragged tiles, wildcard picks, and scores all
// stay intact) but hidden. Also updates which line is highlighted in the
// summary list.
function setActiveScramble(index) {
  activeScrambleIndex = index;
  scrambleCtxs.forEach((ctx, i) => {
    ctx.cardEl.classList.toggle('hidden', i !== index);
    ctx.summaryRowEl.classList.toggle('active', i === index);
  });
}

// Builds all 6 scrambles' tray/guess cards (every scramble is fully
// dealt and interactive from the start — see the class comment at the
// top of this file), plus the always-visible Guess1-6 + Total summary
// list that both reports every guess's current score and, on click,
// switches which single tray/guess pair is shown.
function renderAllScrambles() {
  closeLetterMenu();
  const container = el('scrambles');
  container.innerHTML = '';
  scrambleCtxs = [];

  // Restarting must replace the summary list, not add another one next
  // to it — it lives as a sibling of #scrambles (not inside it), so
  // clearing #scrambles' innerHTML above doesn't remove a previous one.
  const oldSummaryList = el('guess-summary');
  if (oldSummaryList) oldSummaryList.remove();

  const summaryList = document.createElement('div');
  summaryList.id = 'guess-summary';

  scrambles.forEach((scramble, idx) => {
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
    const tilesDiv2 = document.createElement('div');
    tilesDiv2.className = 'tiles row-tiles tiles-duplicate';
    const tilesStack = document.createElement('div');
    tilesStack.className = 'tiles-stack';
    tilesStack.appendChild(tilesDiv);
    tilesStack.appendChild(tilesDiv2);

    top.appendChild(shuffleBtn);
    top.appendChild(tilesStack);
    card.appendChild(top);
    container.appendChild(card);

    const ctx = {
      scramble,
      index: idx,
      tilesEl: tilesDiv,
      tilesEl2: tilesDiv2,
      topTiles: [...scramble.displayTiles],
      cardEl: card,
      guessScore: 0,
    };
    scrambleCtxs.push(ctx);

    // Guess1-6 line: label + score, clickable to make this pair active.
    const summaryRow = document.createElement('div');
    summaryRow.className = 'guess-summary-row';
    summaryRow.innerHTML = `<span class="guess-summary-label">Guess ${idx + 1}</span><span class="guess-summary-score">0</span>`;
    summaryRow.addEventListener('click', () => setActiveScramble(idx));
    summaryList.appendChild(summaryRow);
    ctx.summaryRowEl = summaryRow;

    renderTopRow(ctx);
    renderBlankTileEls(tilesDiv2, scramble.displayTiles, scramble.bottomBonuses);
    attachBottomCellHandlers(ctx);
    attachTopRowDropHandler(ctx);
    updateBottomWordScore(ctx);

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
      ctx.topTiles = [...scramble.displayTiles];
      renderTopRow(ctx);
      renderBlankTileEls(tilesDiv2, scramble.displayTiles, scramble.bottomBonuses);
      attachBottomCellHandlers(ctx);
      updateBottomWordScore(ctx);
    });
  });

  // Guess list on the left, Time Left/Score on the right, side by side —
  // #bottom-panels is created once and reused (rather than rebuilt every
  // restart) since it holds #info-blocks, which is a static element from
  // all6.html; moving it here via appendChild only needs to happen once.
  let bottomPanels = el('bottom-panels');
  if (!bottomPanels) {
    bottomPanels = document.createElement('div');
    bottomPanels.id = 'bottom-panels';
    el('game').appendChild(bottomPanels);
    bottomPanels.appendChild(el('info-blocks'));
  }
  bottomPanels.insertBefore(summaryList, el('info-blocks'));
  setActiveScramble(0);
}

el('stop-btn').addEventListener('click', () => {
  if (!gameActive) return;
  endGame();
});

function endGame() {
  gameActive = false;
  clearInterval(timerHandle);
  closeLetterMenu();
  el('stop-btn').classList.add('hidden');
}

el('start-btn').addEventListener('click', startGame);
