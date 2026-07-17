'use strict';

// src/fog.js
// THE FOG FILTER. This is the ONLY module that owns hidden-information logic.
// Every per-viewer emit that touches board or move-log data passes through here.
// Invariant (CONTRACT.md 11.1 / CONTRACT-v2 G1): nothing produced here may carry an
// opponent piece `type` (standard OR fairy), except a revealed `capturedType` and
// the full reveal in revealBoard (used ONLY for gameOver.fullBoard).
//
// v2: generalized to variable board dimensions and fairy names, WITHOUT teaching
// this module any chaos rules. It works against a "board source" abstraction: any
// object exposing `get(sq) -> {type,color} | null`. Classic passes the chess.js
// instance directly (it already has `.get`); chaos passes a thin wrapper. fog.js
// never imports chaos.js.

const DEFAULT_DIMS = { cols: 8, rows: 8 };

// Piece display names — standard + fairy (own-move text only; opponent stays
// anonymized). Fairy names per CONTRACT-v2 B.4.
const PIECE_NAMES = {
  p: 'Pawn', n: 'Knight', b: 'Bishop', r: 'Rook', q: 'Queen', k: 'King',
  a: 'Amazon', c: 'Chancellor', h: 'Archbishop', i: 'Nightrider', m: 'Camel', w: 'Wizard',
};

// Square parse rule (CONTRACT-v2 B.2): leading letter = file, trailing digits =
// rank. NEVER index sq[1] for the rank (breaks on "a10").
const SQUARE_RE = /^([a-z])([0-9]{1,2})$/;

/** allSquares(dims) -> ordered list of every "cols*rows" square string. */
function allSquares(dims) {
  const d = dims || DEFAULT_DIMS;
  const out = [];
  for (let r = d.rows; r >= 1; r--) {
    for (let f = 0; f < d.cols; f++) {
      out.push(String.fromCharCode(97 + f) + r);
    }
  }
  return out;
}

// Classic 8x8 square list (used by the classic-only check helpers below).
const ALL_SQUARES = allSquares(DEFAULT_DIMS);

/** An all-null board object keyed by every square of `dims` (default 8x8). */
function emptyBoard(dims) {
  const board = {};
  for (const sq of allSquares(dims)) board[sq] = null;
  return board;
}

/**
 * filterBoard(source, viewerColor, dims) -> per-viewer filtered board.
 * For each square of `dims`:
 *   - viewer own piece  -> { type, color }   (type may be a fairy letter)
 *   - opponent piece    -> { occupied: true } (NEVER type/color, any class)
 *   - empty             -> null
 */
function filterBoard(source, viewerColor, dims) {
  const board = {};
  for (const sq of allSquares(dims)) {
    const p = source.get(sq);
    if (!p) {
      board[sq] = null;
    } else if (p.color === viewerColor) {
      board[sq] = { type: p.type, color: p.color };
    } else {
      board[sq] = { occupied: true };
    }
  }
  return board;
}

/**
 * revealBoard(source, dims) -> full board. Every occupied square is a full
 * { type, color }; empty squares null. Both colors visible. USED ONLY for
 * gameOver.fullBoard.
 */
function revealBoard(source, dims) {
  const board = {};
  for (const sq of allSquares(dims)) {
    const p = source.get(sq);
    board[sq] = p ? { type: p.type, color: p.color } : null;
  }
  return board;
}

/**
 * filterMoveRecord(record, viewerColor, config) -> log entry.
 * Own move: full detail (piece + san + text). Opponent move: anonymized, with NO
 * `piece` and NO `san` (a fairy opponent move still reads "unknown piece: ..").
 * `capturedType` is only surfaced when revealCapturedPieceType is on (default true).
 */
function filterMoveRecord(record, viewerColor, config) {
  const reveal = !!(config && config.revealCapturedPieceType);
  const capturedType = record.capture && reveal ? record.capturedType : null;
  const capName = capturedType ? (PIECE_NAMES[capturedType] || capturedType) : null;
  const capSuffix = capName ? ` (captured ${capName})` : '';

  if (record.color === viewerColor) {
    const name = PIECE_NAMES[record.piece] || record.piece;
    return {
      ply: record.ply,
      color: record.color,
      from: record.from,
      to: record.to,
      piece: record.piece,
      san: record.san === undefined ? null : record.san,
      capture: !!record.capture,
      capturedType,
      promotion: record.promotion || null,
      own: true,
      text: `${name} ${record.from}->${record.to}${capSuffix}`,
    };
  }

  // Opponent move: anonymized. Never include piece/san/promotion identity.
  return {
    ply: record.ply,
    color: record.color,
    from: record.from,
    to: record.to,
    capture: !!record.capture,
    capturedType,
    own: false,
    text: `unknown piece: ${record.from}->${record.to}${capSuffix}`,
  };
}

// ---- CLASSIC-ONLY check helpers ------------------------------------------
// These operate on a chess.js instance over the fixed 8x8 board. Chaos has no
// check concept; game.js supplies inCheck:false/checkSquare:null for chaos and
// never calls these.

/** Locate a color king square by scanning the 8x8 board. */
function findKing(chess, color) {
  for (const sq of ALL_SQUARES) {
    const p = chess.get(sq);
    if (p && p.type === 'k' && p.color === color) return sq;
  }
  return null;
}

function squareToCoords(sq) {
  const m = SQUARE_RE.exec(sq);
  return { f: m[1].charCodeAt(0) - 97, r: parseInt(m[2], 10) };
}
function coordsToSquare(f, r) {
  return String.fromCharCode(97 + f) + r;
}
function inBounds(f, r) {
  return f >= 0 && f < 8 && r >= 1 && r <= 8;
}

/**
 * findAttackerSquare(chess, targetSq, byColor) — CLASSIC ONLY.
 * Returns the square of ONE piece of `byColor` that attacks `targetSq`, or null.
 * Prefers chess.js native `attackers`; falls back to a geometry scan.
 */
function findAttackerSquare(chess, targetSq, byColor) {
  if (typeof chess.attackers === 'function') {
    try {
      const res = chess.attackers(targetSq, byColor);
      if (Array.isArray(res) && res.length) return res[0];
      if (typeof res === 'string' && res) return res;
    } catch (e) {
      // fall through to geometry scan
    }
  }

  const { f, r } = squareToCoords(targetSq);
  const get = (ff, rr) => (inBounds(ff, rr) ? chess.get(coordsToSquare(ff, rr)) : null);

  const knightOffsets = [
    [1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2],
  ];
  for (const [df, dr] of knightOffsets) {
    const p = get(f + df, r + dr);
    if (p && p.color === byColor && p.type === 'n') {
      return coordsToSquare(f + df, r + dr);
    }
  }

  const pawnRank = byColor === 'w' ? r - 1 : r + 1;
  for (const df of [-1, 1]) {
    const p = get(f + df, pawnRank);
    if (p && p.color === byColor && p.type === 'p') {
      return coordsToSquare(f + df, pawnRank);
    }
  }

  const scan = (dirs, types) => {
    for (const [df, dr] of dirs) {
      let ff = f + df;
      let rr = r + dr;
      while (inBounds(ff, rr)) {
        const p = chess.get(coordsToSquare(ff, rr));
        if (p) {
          if (p.color === byColor && types.includes(p.type)) {
            return coordsToSquare(ff, rr);
          }
          break;
        }
        ff += df;
        rr += dr;
      }
    }
    return null;
  };
  const diag = scan([[1, 1], [1, -1], [-1, 1], [-1, -1]], ['b', 'q']);
  if (diag) return diag;
  const orth = scan([[1, 0], [-1, 0], [0, 1], [0, -1]], ['r', 'q']);
  if (orth) return orth;

  for (let df = -1; df <= 1; df++) {
    for (let dr = -1; dr <= 1; dr++) {
      if (df === 0 && dr === 0) continue;
      const p = get(f + df, r + dr);
      if (p && p.color === byColor && p.type === 'k') {
        return coordsToSquare(f + df, r + dr);
      }
    }
  }
  return null;
}

/**
 * checkInfoFor(chess, viewerColor) -> { inCheck, checkSquare } — CLASSIC ONLY.
 * inCheck is true only when it is the viewer to move AND they are in check.
 * Safe on a null chess (returns not-in-check), so a chaos call is a no-op.
 */
function checkInfoFor(chess, viewerColor) {
  if (!chess) return { inCheck: false, checkSquare: null };
  const inCheck = chess.turn() === viewerColor && chess.isCheck();
  if (!inCheck) return { inCheck: false, checkSquare: null };
  const kingSq = findKing(chess, viewerColor);
  const oppColor = viewerColor === 'w' ? 'b' : 'w';
  const checkSquare = kingSq ? findAttackerSquare(chess, kingSq, oppColor) : null;
  return { inCheck: true, checkSquare };
}

module.exports = {
  ALL_SQUARES,
  PIECE_NAMES,
  allSquares,
  emptyBoard,
  filterBoard,
  revealBoard,
  filterMoveRecord,
  checkInfoFor,
  findAttackerSquare,
  findKing,
};
