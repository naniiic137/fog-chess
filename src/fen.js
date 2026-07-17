'use strict';

// src/fen.js
// Arrangement validation + custom-arrangement -> FEN string construction.
// Pure functions, no side effects. See PLAN.md section 6 and CONTRACT.md 0.8.

// Exact composition every arrangement must satisfy: 8 pawns, 2 rooks,
// 2 knights, 2 bishops, 1 queen, 1 king (16 pieces total).
const COMPOSITION = { p: 8, r: 2, n: 2, b: 2, q: 1, k: 1 };

/**
 * validateArrangement(placement, color)
 * @param {Object} placement  { [square]: pieceType } (pieceType lowercase p r n b q k)
 * @param {"w"|"b"} color      submitter color (implies home ranks + piece color)
 * @returns {string|null}      an error reason string, or null when valid.
 *
 * Valid iff: exactly 16 entries; every square matches ^[a-h][1-8]$; every square
 * on the submitter home ranks (White ranks 1-2, Black ranks 7-8); no duplicate
 * squares; and the piece-type multiset is EXACTLY the COMPOSITION above.
 * Pawns on the submitter own back rank (rank 1 White / rank 8 Black) are allowed.
 */
function validateArrangement(placement, color) {
  if (!placement || typeof placement !== 'object') {
    return 'Invalid placement object';
  }
  const entries = Object.entries(placement);
  if (entries.length !== 16) {
    return 'Must place exactly 16 pieces on your home ranks';
  }
  const homeRanks = color === 'w' ? ['1', '2'] : ['7', '8'];
  const counts = {};
  const seen = new Set();
  for (const [sq, type] of entries) {
    if (!/^[a-h][1-8]$/.test(sq)) return `Invalid square: ${sq}`;
    if (seen.has(sq)) return `Duplicate square: ${sq}`;
    seen.add(sq);
    if (!homeRanks.includes(sq[1])) {
      return `Square ${sq} is not on your home ranks`;
    }
    if (typeof type !== 'string' || !/^[prnbqk]$/.test(type)) {
      return `Invalid piece type: ${type}`;
    }
    counts[type] = (counts[type] || 0) + 1;
  }
  for (const t of Object.keys(COMPOSITION)) {
    if ((counts[t] || 0) !== COMPOSITION[t]) {
      return 'Wrong piece composition (need 8p, 2r, 2n, 2b, 1q, 1k)';
    }
  }
  return null;
}

/**
 * buildFen(whitePlacement, blackPlacement)
 * Compose the two secret arrangements into a standard FEN string.
 *
 * - Piece placement is written rank 8 -> rank 1, files a -> h.
 * - White pieces are UPPERCASE (from whitePlacement, ranks 1-2 only);
 *   Black pieces are lowercase (from blackPlacement, ranks 7-8 only).
 *   Ranks 3-6 are always empty. Consecutive empties collapse to a digit.
 * - Side to move is always "w".
 * - Castling field is ALWAYS "-" (castling is dropped in this variant).
 * - En passant "-", halfmove "0", fullmove "1".
 *
 * NOTE (back-rank pawns): This FEN may legally place pawns on rank 1/8, which
 * standard FEN validation rejects. Callers therefore load it with
 * chess.js `load(fen, { skipValidation: true })`. chess.js only grants the
 * two-square pawn move from rank 2 (White) / rank 7 (Black), so a pawn placed
 * on its own back rank advances one square at a time until it reaches rank 2/7.
 * This is ACCEPTED behavior for this variant, not a bug.
 */
function buildFen(whitePlacement, blackPlacement) {
  const map = {}; // square -> FEN char
  for (const [sq, type] of Object.entries(whitePlacement || {})) {
    map[sq] = String(type).toUpperCase();
  }
  for (const [sq, type] of Object.entries(blackPlacement || {})) {
    map[sq] = String(type).toLowerCase();
  }

  const rankStrings = [];
  for (let r = 8; r >= 1; r--) {
    let rankStr = '';
    let empty = 0;
    for (let f = 0; f < 8; f++) {
      const sq = String.fromCharCode(97 + f) + r;
      const c = map[sq];
      if (c) {
        if (empty > 0) {
          rankStr += empty;
          empty = 0;
        }
        rankStr += c;
      } else {
        empty++;
      }
    }
    if (empty > 0) rankStr += empty;
    rankStrings.push(rankStr);
  }

  // side=w, castling='-', en passant='-', halfmove=0, fullmove=1
  return rankStrings.join('/') + ' w - - 0 1';
}

module.exports = { validateArrangement, buildFen, COMPOSITION };
