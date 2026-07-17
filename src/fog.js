'use strict';

// src/fog.js
// THE FOG FILTER. This is the ONLY module that owns hidden-information logic.
// Every per-viewer emit that touches board or move-log data passes through here.
// Invariant (CONTRACT.md section 11.1): nothing produced here may carry an
// opponent piece `type`, except a revealed `capturedType` and the full reveal
// in revealBoard (used ONLY for gameOver.fullBoard).

// All 64 algebraic square names. Order does not matter for object keys.
const ALL_SQUARES = [];
for (let r = 8; r >= 1; r--) {
  for (let f = 0; f < 8; f++) {
    ALL_SQUARES.push(String.fromCharCode(97 + f) + r);
  }
}

const PIECE_NAMES = {
  p: 'Pawn', n: 'Knight', b: 'Bishop', r: 'Rook', q: 'Queen', k: 'King',
};

/** A 64-key board object with every square null. */
function emptyBoard() {
  const board = {};
  for (const sq of ALL_SQUARES) board[sq] = null;
  return board;
}

/**
 * filterBoard(chess, viewerColor) -> CONTRACT 0.6 filtered board.
 * For each of the 64 squares:
 *   - viewer own piece  -> { type, color }
 *   - opponent piece    -> { occupied: true }   (never type, never color)
 *   - empty             -> null
 */
function filterBoard(chess, viewerColor) {
  const board = {};
  for (const sq of ALL_SQUARES) {
    const p = chess.get(sq);
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
 * revealBoard(chess) -> CONTRACT 0.7 full board.
 * Every occupied square is a full { type, color }; empty squares null.
 * Both colors fully visible. USED ONLY for gameOver.fullBoard.
 */
function revealBoard(chess) {
  const board = {};
  for (const sq of ALL_SQUARES) {
    const p = chess.get(sq);
    board[sq] = p ? { type: p.type, color: p.color } : null;
  }
  return board;
}

/**
 * filterMoveRecord(record, viewerColor, config) -> CONTRACT 0.9 log entry.
 * Own move: full detail (piece + san + text). Opponent move: anonymized, with
 * NO `piece` and NO `san`. `capturedType` is only surfaced when the config flag
 * revealCapturedPieceType is on (default true).
 */
function filterMoveRecord(record, viewerColor, config) {
  const reveal = !!(config && config.revealCapturedPieceType);
  const capturedType = record.capture && reveal ? record.capturedType : null;
  const capSuffix = capturedType ? ` (captured ${PIECE_NAMES[capturedType]})` : '';

  if (record.color === viewerColor) {
    // Own move: reveal everything.
    return {
      ply: record.ply,
      color: record.color,
      from: record.from,
      to: record.to,
      piece: record.piece,
      san: record.san,
      capture: !!record.capture,
      capturedType,
      promotion: record.promotion || null,
      own: true,
      text: `${PIECE_NAMES[record.piece]} ${record.from}->${record.to}${capSuffix}`,
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

/** Locate a color king square by scanning the board. */
function findKing(chess, color) {
  for (const sq of ALL_SQUARES) {
    const p = chess.get(sq);
    if (p && p.type === 'k' && p.color === color) return sq;
  }
  return null;
}

function squareToCoords(sq) {
  return { f: sq.charCodeAt(0) - 97, r: parseInt(sq[1], 10) };
}
function coordsToSquare(f, r) {
  return String.fromCharCode(97 + f) + r;
}
function inBounds(f, r) {
  return f >= 0 && f < 8 && r >= 1 && r <= 8;
}

/**
 * findAttackerSquare(chess, targetSq, byColor)
 * Returns the square of ONE piece of `byColor` that attacks `targetSq`, or null.
 *
 * Prefers chess.js native `attackers(square, color)` (present in 1.4.0). If that
 * is unavailable or throws, falls back to a version-agnostic geometry scan so we
 * never depend on a specific chess.js build. Only the square is ever returned;
 * the checking piece identity is never exposed to callers.
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

  // Knight attackers
  const knightOffsets = [
    [1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2],
  ];
  for (const [df, dr] of knightOffsets) {
    const p = get(f + df, r + dr);
    if (p && p.color === byColor && p.type === 'n') {
      return coordsToSquare(f + df, r + dr);
    }
  }

  // Pawn attackers. A white pawn attacks toward higher ranks (sits on r-1);
  // a black pawn attacks toward lower ranks (sits on r+1).
  const pawnRank = byColor === 'w' ? r - 1 : r + 1;
  for (const df of [-1, 1]) {
    const p = get(f + df, pawnRank);
    if (p && p.color === byColor && p.type === 'p') {
      return coordsToSquare(f + df, pawnRank);
    }
  }

  // Sliding attackers.
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
          break; // blocked by a piece
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

  // King adjacency (kings cannot legally deliver check, included for completeness).
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
 * checkInfoFor(chess, viewerColor) -> { inCheck, checkSquare }
 * inCheck is true only when it is the viewer to move AND they are in check.
 * checkSquare is the square of a checking piece (identity withheld), else null.
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
  emptyBoard,
  filterBoard,
  revealBoard,
  filterMoveRecord,
  checkInfoFor,
  findAttackerSquare,
  findKing,
};
