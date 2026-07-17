'use strict';

// src/chaos.js
// The CHAOS variant engine. Fully isolated: NO chess.js, no socket knowledge, no
// phase machine. Pure data + functions. game.js owns the phase machine and calls
// into here; fog.js never imports this file (it only iterates squares via a source
// wrapper). All movement math for the chaos mode lives here and NOWHERE else.
//
// Win condition = KING CAPTURE. There is no check / checkmate / self-check: a move
// is legal iff it is on-board, movement-consistent, and does not land on a friendly
// piece. Kings (royal:true) are ordinary capturable pieces; a side may hold several.
// A side to move with no legal moves is a DRAW ("stalemate").

// ---- shared vector sets (CONTRACT-v2 B.3) --------------------------------

const ORTHO = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const ALL8 = ORTHO.concat(DIAG);
const KNIGHT = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const CAMEL = [[1, 3], [3, 1], [3, -1], [1, -3], [-1, -3], [-3, -1], [-3, 1], [-1, 3]];

const VECTORS = { ORTHO, DIAG, ALL8, KNIGHT, CAMEL };

// ---- piece catalog (CONTRACT-v2 B.4) -------------------------------------
// Each entry stores EXPANDED [dx,dy] arrays (the CONTRACT tokens are shorthand).
// leaps: single jumps (ignore blockers). slides: ride the vector until off-board
// or blocked (capture first enemy, then stop; never pass/land on friendly).

const CATALOG = {
  p: { name: 'Pawn', class: 'standard', royal: false, pawn: true, leaps: [], slides: [] },
  n: { name: 'Knight', class: 'standard', royal: false, pawn: false, leaps: KNIGHT, slides: [] },
  b: { name: 'Bishop', class: 'standard', royal: false, pawn: false, leaps: [], slides: DIAG },
  r: { name: 'Rook', class: 'standard', royal: false, pawn: false, leaps: [], slides: ORTHO },
  q: { name: 'Queen', class: 'standard', royal: false, pawn: false, leaps: [], slides: ALL8 },
  k: { name: 'King', class: 'standard', royal: true, pawn: false, leaps: ALL8, slides: [] },
  a: { name: 'Amazon', class: 'fairy', royal: false, pawn: false, leaps: KNIGHT, slides: ALL8 },
  c: { name: 'Chancellor', class: 'fairy', royal: false, pawn: false, leaps: KNIGHT, slides: ORTHO },
  h: { name: 'Archbishop', class: 'fairy', royal: false, pawn: false, leaps: KNIGHT, slides: DIAG },
  i: { name: 'Nightrider', class: 'fairy', royal: false, pawn: false, leaps: [], slides: KNIGHT },
  m: { name: 'Camel', class: 'fairy', royal: false, pawn: false, leaps: CAMEL, slides: [] },
  w: { name: 'Wizard', class: 'fairy', royal: false, pawn: false, leaps: CAMEL.concat(DIAG), slides: [] },
};

const STANDARD_TYPES = ['p', 'n', 'b', 'r', 'q', 'k'];
const FAIRY_TYPES = ['a', 'c', 'h', 'i', 'm', 'w'];
const ALL_TYPES = STANDARD_TYPES.concat(FAIRY_TYPES);

// Promotion preference order (default 'q' first if present). Filtered to the
// roster's non-royal, non-pawn, enabled types. Ordering matches CONTRACT-v2's
// example ("q","r","b","n","a").
const PROMO_ORDER = ['q', 'r', 'b', 'n', 'a', 'c', 'h', 'i', 'm', 'w'];

// Supported board dimensions (CONTRACT-v2 B.1). cols 8..10, rows 8 or 10.
const SUPPORTED_ROWS = [8, 10];

// ---- coordinate helpers (PLAN-v2 3.2) ------------------------------------
// Square = <fileLetter><rankNumber>. File is ALWAYS a single letter (cols<=10<=26),
// rank is 1..rows (may be two digits). Parse rule: ^([a-z])([0-9]{1,2})$.

const SQUARE_RE = /^([a-z])([0-9]{1,2})$/;

function fileIndex(letter) {
  return letter.charCodeAt(0) - 97;
}
function fileLetter(index) {
  return String.fromCharCode(97 + index);
}
/** parseSquare("a10") -> { f:0, r:10 } | null. NEVER indexes sq[1] for the rank. */
function parseSquare(sq) {
  if (typeof sq !== 'string') return null;
  const m = SQUARE_RE.exec(sq);
  if (!m) return null;
  const f = fileIndex(m[1]);
  const r = parseInt(m[2], 10);
  if (!Number.isInteger(r) || r < 1) return null;
  return { f, r };
}
/** toSquare(0,1) -> "a1". f is 0-based col, r is 1-based rank. */
function toSquare(f, r) {
  return fileLetter(f) + r;
}
function onBoard(f, r, dims) {
  return f >= 0 && f < dims.cols && r >= 1 && r <= dims.rows;
}
/** Ordered list of every square of the board (rows high->low, files a->..). */
function allSquares(dims) {
  const out = [];
  for (let r = dims.rows; r >= 1; r--) {
    for (let f = 0; f < dims.cols; f++) {
      out.push(toSquare(f, r));
    }
  }
  return out;
}

// ---- board helpers -------------------------------------------------------

function pieceAt(board, f, r, dims) {
  if (!onBoard(f, r, dims)) return undefined;
  return board[toSquare(f, r)];
}
function isRoyal(type) {
  return !!(CATALOG[type] && CATALOG[type].royal);
}
function countRoyals(board, color) {
  let n = 0;
  for (const sq of Object.keys(board)) {
    const p = board[sq];
    if (p && p.color === color && isRoyal(p.type)) n++;
  }
  return n;
}

// ---- pawn helpers --------------------------------------------------------

function pawnDir(color) {
  return color === 'w' ? 1 : -1;
}
function pawnSecondRank(color, dims) {
  return color === 'w' ? 2 : dims.rows - 1;
}
function pawnFarRank(color, dims) {
  return color === 'w' ? dims.rows : 1;
}

/** Pawn move generation (CONTRACT-v2 B.5). Returns [{to, promotion:bool}]. */
function pawnMovesFrom(board, sq, color, dims) {
  const at = parseSquare(sq);
  if (!at) return [];
  const { f, r } = at;
  const dy = pawnDir(color);
  const farRank = pawnFarRank(color, dims);
  const out = [];

  const pushMove = (tf, tr) => {
    out.push({ to: toSquare(tf, tr), promotion: tr === farRank });
  };

  // Forward 1 (must be empty).
  const r1 = r + dy;
  if (onBoard(f, r1, dims) && !pieceAt(board, f, r1, dims)) {
    pushMove(f, r1);
    // Double-step: only from the color's second rank, both squares empty.
    if (r === pawnSecondRank(color, dims)) {
      const r2 = r + 2 * dy;
      if (onBoard(f, r2, dims) && !pieceAt(board, f, r2, dims)) {
        pushMove(f, r2);
      }
    }
  }

  // Diagonal captures (enemy only). No en passant.
  for (const df of [-1, 1]) {
    const tf = f + df;
    const tr = r + dy;
    const target = pieceAt(board, tf, tr, dims);
    if (target && target.color !== color) {
      pushMove(tf, tr);
    }
  }

  return out;
}

// ---- general move generation (PLAN-v2 5.2) -------------------------------

/**
 * movesFrom(board, sq, dims) -> [{ to, promotion:bool }]
 * Own piece assumed by caller for turn semantics; this function only enforces
 * movement geometry + friendly-block. Promotion flag is set for pawn moves that
 * land on the far rank; false for all non-pawn moves. Targets are de-duplicated
 * (a target reachable by multiple vectors appears once; promotion OR'd).
 */
function movesFrom(board, sq, dims) {
  const piece = board[sq];
  if (!piece) return [];
  const def = CATALOG[piece.type];
  if (!def) return [];

  if (def.pawn) return dedupe(pawnMovesFrom(board, sq, piece.color, dims));

  const at = parseSquare(sq);
  if (!at) return [];
  const { f, r } = at;
  const color = piece.color;
  const out = [];

  // Leaps: single jump; blockers ignored. Legal if on-board and not friendly.
  for (const [dx, dy] of def.leaps) {
    const tf = f + dx;
    const tr = r + dy;
    if (!onBoard(tf, tr, dims)) continue;
    const target = pieceAt(board, tf, tr, dims);
    if (target && target.color === color) continue; // cannot land on friendly
    out.push({ to: toSquare(tf, tr), promotion: false });
  }

  // Slides: ride the vector (incl. Nightrider's KNIGHT vector) until off-board or
  // blocked. Capture the first enemy then stop; never pass/land on a friendly.
  for (const [dx, dy] of def.slides) {
    let k = 1;
    while (true) {
      const tf = f + dx * k;
      const tr = r + dy * k;
      if (!onBoard(tf, tr, dims)) break;
      const target = pieceAt(board, tf, tr, dims);
      if (!target) {
        out.push({ to: toSquare(tf, tr), promotion: false });
        k++;
        continue;
      }
      if (target.color !== color) {
        out.push({ to: toSquare(tf, tr), promotion: false }); // capture, then stop
      }
      break; // blocked (friendly or just-captured enemy)
    }
  }

  return dedupe(out);
}

function dedupe(moves) {
  const byTarget = new Map();
  for (const m of moves) {
    if (!byTarget.has(m.to)) byTarget.set(m.to, !!m.promotion);
    else if (m.promotion) byTarget.set(m.to, true);
  }
  return [...byTarget.entries()].map(([to, promotion]) => ({ to, promotion }));
}

/** allMoves(board, color, dims) -> [{from, to, promotion}] over all color pieces. */
function allMoves(board, color, dims) {
  const out = [];
  for (const sq of Object.keys(board)) {
    const p = board[sq];
    if (!p || p.color !== color) continue;
    for (const m of movesFrom(board, sq, dims)) {
      out.push({ from: sq, to: m.to, promotion: m.promotion });
    }
  }
  return out;
}

// ---- promotion resolution (CONTRACT-v2 B.5) ------------------------------

/** promotionTypes(config) -> ordered roster types eligible for pawn promotion. */
function promotionTypes(config) {
  const roster = (config && config.roster) || {};
  const banned = new Set((config && config.bannedTypes) || []);
  const enabledFairy = new Set((config && config.enabledFairy) || []);
  const out = [];
  for (const t of PROMO_ORDER) {
    if (t === 'p') continue;
    if (isRoyal(t)) continue;
    if (!roster[t] || roster[t] <= 0) continue;
    if (banned.has(t)) continue;
    if (CATALOG[t] && CATALOG[t].class === 'fairy' && !enabledFairy.has(t)) continue;
    out.push(t);
  }
  return out;
}

/** Resolve a client's promotion choice against the roster options. */
function resolvePromotion(choice, config) {
  const options = promotionTypes(config);
  if (options.length === 0) return null; // degenerate roster: pawn stays a pawn
  if (choice && options.includes(choice)) return choice;
  if (options.includes('q')) return 'q';
  return options[0];
}

// ---- makeMove / applyMove (PLAN-v2 5.3) ----------------------------------

/**
 * applyMove(board, dims, config, color, from, to, promotion)
 * Mutates `board`. Assumes caller already checked it is `color`'s turn.
 * Returns { ok:false, error } or:
 *   { ok:true, captured:{type,color,square}|null, movedType, promotedTo,
 *     ended, result }
 * where result (when ended) is { result, winner, reason }.
 *   - king capture drops opponent royals to 0  -> result "kingCaptured", winner=mover
 *   - else if the NEW side to move has no legal moves -> result "stalemate", winner null
 */
function applyMove(board, dims, config, color, from, to, promotion) {
  if (typeof from !== 'string' || typeof to !== 'string') {
    return { ok: false, error: 'Illegal move' };
  }
  const piece = board[from];
  if (!piece || piece.color !== color) {
    return { ok: false, error: 'You have no piece on that square' };
  }
  const legal = movesFrom(board, from, dims);
  const chosen = legal.find((m) => m.to === to);
  if (!chosen) return { ok: false, error: 'Illegal move' };

  const movedType = piece.type;

  // Capture: destination always holds an enemy (friendly landings are illegal).
  // No en passant in chaos, so the capture square is always the destination.
  let captured = null;
  const occupant = board[to];
  if (occupant) {
    captured = { type: occupant.type, color: occupant.color, square: to };
  }

  // Move the piece.
  board[to] = piece;
  delete board[from];

  // Promotion (pawn reaching the far rank).
  let promotedTo = null;
  if (CATALOG[movedType] && CATALOG[movedType].pawn && chosen.promotion) {
    const resolved = resolvePromotion(promotion, config);
    if (resolved) {
      board[to] = { type: resolved, color };
      promotedTo = resolved;
    }
    // else: no promotion type available -> pawn stays a pawn on the far rank.
  }

  const oppColor = color === 'w' ? 'b' : 'w';

  // Win check: opponent royals reduced to zero -> mover wins by king capture.
  let ended = false;
  let result = null;
  if (countRoyals(board, oppColor) === 0) {
    ended = true;
    result = { result: 'kingCaptured', winner: color, reason: 'kingCaptured' };
  } else if (allMoves(board, oppColor, dims).length === 0) {
    // Draw: the side to move next has no legal move (stalemate-like).
    ended = true;
    result = { result: 'stalemate', winner: null, reason: 'stalemate' };
  }

  return { ok: true, captured, movedType, promotedTo, ended, result };
}

// ---- config: home region + validation (PLAN-v2 7, 8.4) -------------------

function rosterTotal(roster) {
  let t = 0;
  for (const k of Object.keys(roster || {})) {
    const v = roster[k];
    if (Number.isFinite(v) && v > 0) t += v;
  }
  return t;
}

/** Number of home ranks per side: N = max(2, ceil(total/cols)). */
function homeRankCount(config) {
  const total = rosterTotal(config.roster);
  const cols = config.boardDims.cols;
  return Math.max(2, Math.ceil(total / cols));
}

/** homeRanks(config, color) -> array of rank numbers for that side's home region. */
function homeRanks(config, color) {
  const N = homeRankCount(config);
  const rows = config.boardDims.rows;
  const out = [];
  if (color === 'w') {
    for (let r = 1; r <= N; r++) out.push(r);
  } else {
    for (let r = rows - N + 1; r <= rows; r++) out.push(r);
  }
  return out;
}

function isSupportedDims(dims) {
  if (!dims || !Number.isInteger(dims.cols) || !Number.isInteger(dims.rows)) return false;
  if (dims.cols < 8 || dims.cols > 10) return false;
  if (!SUPPORTED_ROWS.includes(dims.rows)) return false;
  return true;
}

/**
 * validateConfig(config) -> { valid:true } | { valid:false, error }
 * Enforces CONTRACT-v2 B.6 / G7 constraints. Assumes the config is already
 * shape-sanitized by game.js (mode/dims/roster present).
 */
function validateConfig(config) {
  if (!config || typeof config !== 'object') {
    return { valid: false, error: 'Missing config.' };
  }
  if (config.mode !== 'classic' && config.mode !== 'chaos') {
    return { valid: false, error: 'Mode must be classic or chaos.' };
  }
  const dims = config.boardDims;
  if (!isSupportedDims(dims)) {
    return { valid: false, error: 'Unsupported board dimensions (use 8x8, 10x8, or 10x10).' };
  }
  const roster = config.roster || {};
  const banned = new Set(config.bannedTypes || []);
  const enabledFairy = new Set(config.enabledFairy || []);

  const rosterKeys = Object.keys(roster).filter((t) => roster[t] > 0);
  for (const t of rosterKeys) {
    if (!CATALOG[t]) {
      return { valid: false, error: `Unknown piece type "${t}".` };
    }
    if (!Number.isInteger(roster[t]) || roster[t] < 0) {
      return { valid: false, error: `Invalid count for "${CATALOG[t].name}".` };
    }
    if (banned.has(t)) {
      return { valid: false, error: `${CATALOG[t].name} is banned but present in the roster.` };
    }
    if (CATALOG[t].class === 'fairy' && !enabledFairy.has(t)) {
      return { valid: false, error: `${CATALOG[t].name} must be enabled to be used.` };
    }
  }

  const kings = roster.k || 0;
  if (kings < 1) {
    return { valid: false, error: 'At least one king is required.' };
  }

  const total = rosterTotal(roster);
  if (total < 1) {
    return { valid: false, error: 'The roster is empty.' };
  }

  // Home-region fit: 2 * max(2, ceil(total/cols)) <= rows.
  const N = homeRankCount(config);
  if (2 * N > dims.rows) {
    return {
      valid: false,
      error: `Roster too large for a ${dims.rows}-tall board (needs ${N} home ranks per side).`,
    };
  }

  return { valid: true, error: null };
}

// ---- arrangement (PLAN-v2 7) ---------------------------------------------

/**
 * validateArrangement(placement, color, config) -> error string | null
 * Valid iff: every square parses + is on-board + within the submitter's home
 * region; no duplicate squares; each placed type is enabled/allowed; and the
 * placed multiset EXACTLY equals the agreed roster.
 */
function validateArrangement(placement, color, config) {
  if (!placement || typeof placement !== 'object') {
    return 'Invalid placement object';
  }
  const dims = config.boardDims;
  const roster = config.roster || {};
  const banned = new Set(config.bannedTypes || []);
  const enabledFairy = new Set(config.enabledFairy || []);
  const home = new Set(homeRanks(config, color));

  const entries = Object.entries(placement);
  const counts = {};
  const seen = new Set();

  for (const [sq, type] of entries) {
    const at = parseSquare(sq);
    if (!at) return `Invalid square: ${sq}`;
    if (!onBoard(at.f, at.r, dims)) return `Square off board: ${sq}`;
    if (seen.has(sq)) return `Duplicate square: ${sq}`;
    seen.add(sq);
    if (!home.has(at.r)) return `Square ${sq} is not in your home region`;
    if (typeof type !== 'string' || !CATALOG[type]) return `Invalid piece type: ${type}`;
    if (banned.has(type)) return `${CATALOG[type].name} is banned`;
    if (CATALOG[type].class === 'fairy' && !enabledFairy.has(type)) {
      return `${CATALOG[type].name} is not enabled`;
    }
    counts[type] = (counts[type] || 0) + 1;
  }

  // Multiset must equal the roster EXACTLY.
  const rosterTypes = new Set([
    ...Object.keys(roster).filter((t) => roster[t] > 0),
    ...Object.keys(counts),
  ]);
  for (const t of rosterTypes) {
    if ((counts[t] || 0) !== (roster[t] || 0)) {
      return 'Placed pieces do not match the agreed roster';
    }
  }

  return null;
}

/** buildBoard(whitePlacement, blackPlacement, config) -> { [square]: {type,color} }. */
function buildBoard(whitePlacement, blackPlacement, config) {
  const board = {};
  for (const [sq, type] of Object.entries(whitePlacement || {})) {
    board[sq] = { type, color: 'w' };
  }
  for (const [sq, type] of Object.entries(blackPlacement || {})) {
    board[sq] = { type, color: 'b' };
  }
  return board;
}

/** Thin board source for fog.js (mirrors chess.js .get(sq) contract). */
function boardSource(board) {
  return { get: (sq) => board[sq] || null };
}

module.exports = {
  // reference data
  CATALOG,
  VECTORS,
  ORTHO, DIAG, ALL8, KNIGHT, CAMEL,
  STANDARD_TYPES, FAIRY_TYPES, ALL_TYPES,
  SUPPORTED_ROWS,
  // coords
  SQUARE_RE,
  fileIndex, fileLetter, parseSquare, toSquare, onBoard, allSquares,
  // board / rules
  isRoyal, countRoyals,
  movesFrom, allMoves, applyMove,
  promotionTypes, resolvePromotion,
  // config / setup
  validateConfig, homeRanks, homeRankCount, rosterTotal, isSupportedDims,
  validateArrangement, buildBoard, boardSource,
};
