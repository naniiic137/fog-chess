'use strict';

// src/game.js
// GameState machine for the single Fog Chess match. Holds the authoritative
// full-information chess.js instance (server-only, NEVER emitted raw), the phase
// machine, players, arrangements, ready/rematch flags, and the full-info move log.
// Per-viewer filtering is delegated to src/fog.js so hidden-info logic lives in
// exactly one place.

const { Chess } = require('chess.js');
const { validateArrangement, buildFen } = require('./fen');
const fog = require('./fog');

class FogChessGame {
  constructor(config) {
    this.config = config || { revealCapturedPieceType: true };
    this.reset();
    this.players = { white: null, black: null };
  }

  // Full reset back to an empty lobby (used by the constructor).
  reset() {
    this.phase = 'lobby'; // "lobby" | "setup" | "playing" | "ended"
    this.chess = null; // chess.js instance (full truth, server-only)
    this.arrangements = { white: null, black: null };
    this.ready = { white: false, black: false };
    this.rematch = { white: false, black: false };
    this.moveLog = []; // full-info MoveRecords; filtered per viewer at emit
    this.turn = 'w';
    this.result = null; // { result, winner, reason }
    this.startFen = null;
  }

  // ---- helpers ------------------------------------------------------------

  static keyOf(color) {
    return color === 'w' ? 'white' : 'black';
  }

  colorOf(socketId) {
    if (this.players.white === socketId) return 'w';
    if (this.players.black === socketId) return 'b';
    return null;
  }

  socketOf(color) {
    return color === 'w' ? this.players.white : this.players.black;
  }

  // ---- connection / role assignment --------------------------------------

  /** Assign the next free slot. Returns { color, role } or null when full. */
  addPlayer(socketId) {
    if (this.players.white === null) {
      this.players.white = socketId;
      return { color: 'w', role: 'white' };
    }
    if (this.players.black === null) {
      this.players.black = socketId;
      return { color: 'b', role: 'black' };
    }
    return null;
  }

  /** lobby -> setup once both slots are filled. Returns true on transition. */
  maybeStartSetup() {
    if (this.phase === 'lobby' && this.players.white && this.players.black) {
      this.phase = 'setup';
      return true;
    }
    return false;
  }

  /**
   * Minimal disconnect handling (reconnect is out of scope). Frees the slot.
   * If a game was in progress, ends it with an opponentLeft result so the peer
   * is not stuck. In lobby/setup, resets the shared setup state back to lobby.
   * Returns { color, ended } or null when the socket held no slot.
   */
  handleDisconnect(socketId) {
    const color = this.colorOf(socketId);
    if (!color) return null;
    this.players[FogChessGame.keyOf(color)] = null;

    if (this.phase === 'playing') {
      this.phase = 'ended';
      this.result = {
        result: 'opponentLeft',
        winner: color === 'w' ? 'b' : 'w',
        reason: 'opponentLeft',
      };
      return { color, ended: true };
    }

    if (this.phase === 'setup') {
      // The other player has no valid opponent anymore; drop back to lobby-wait
      // and clear any in-progress readiness/arrangements.
      this.phase = 'lobby';
      this.arrangements = { white: null, black: null };
      this.ready = { white: false, black: false };
      this.rematch = { white: false, black: false };
      this.chess = null;
      this.moveLog = [];
      this.result = null;
    }
    return { color, ended: false };
  }

  // ---- setup phase --------------------------------------------------------

  /**
   * submitArrangement(color, placement)
   * Validates and records a player secret arrangement (doubles as "ready").
   * Returns { ok:false, reason } or { ok:true, started } where `started` is true
   * when this submission completed both sides and the game moved to playing.
   */
  submitArrangement(color, placement) {
    if (this.phase !== 'setup') {
      return { ok: false, reason: 'Not in setup phase' };
    }
    const reason = validateArrangement(placement, color);
    if (reason) return { ok: false, reason };

    const key = FogChessGame.keyOf(color);
    this.arrangements[key] = placement;
    this.ready[key] = true;

    let started = false;
    if (this.ready.white && this.ready.black) {
      this.startPlaying();
      started = true;
    }
    return { ok: true, started };
  }

  /** setup -> playing: build the FEN, load with skipValidation, White to move. */
  startPlaying() {
    const fen = buildFen(this.arrangements.white, this.arrangements.black);
    this.chess = new Chess();
    // skipValidation is required: pawns may legally sit on rank 1/8 here.
    this.chess.load(fen, { skipValidation: true });
    this.startFen = fen;
    this.turn = 'w';
    this.phase = 'playing';
  }

  // ---- playing phase ------------------------------------------------------

  /**
   * getLegalMoves(color, square) -> { square, moves, hasMoves } (CONTRACT 3).
   * Empty moves if not the requester turn, empty square, or an opponent piece.
   * Promotion targets are collapsed to a single { to, promotion:true } entry.
   */
  getLegalMoves(color, square) {
    if (this.phase !== 'playing' || this.turn !== color || !this.chess) {
      return { square, moves: [], hasMoves: false };
    }
    if (typeof square !== 'string' || !/^[a-h][1-8]$/.test(square)) {
      return { square, moves: [], hasMoves: false };
    }
    const piece = this.chess.get(square);
    if (!piece || piece.color !== color) {
      return { square, moves: [], hasMoves: false };
    }
    const verbose = this.chess.moves({ square, verbose: true });
    const byTarget = new Map();
    for (const m of verbose) {
      const isPromo = !!(m.flags && m.flags.includes('p'));
      if (!byTarget.has(m.to)) byTarget.set(m.to, isPromo);
      else if (isPromo) byTarget.set(m.to, true);
    }
    const moves = [...byTarget.entries()].map(([to, promotion]) => ({ to, promotion }));
    return { square, moves, hasMoves: moves.length > 0 };
  }

  /**
   * makeMove(color, from, to, promotion)
   * Validates turn + ownership + legality via chess.js, applies the move, appends
   * a full MoveRecord, flips the turn, runs end detection. Returns:
   *   { ok:false, error } on rejection, or
   *   { ok:true, record, capture, ended, result }
   * where `capture` is { square, capturedType, capturedColor } or null.
   */
  makeMove(color, from, to, promotion) {
    if (this.phase !== 'playing' || !this.chess) {
      return { ok: false, error: 'Game not in progress' };
    }
    if (this.turn !== color) {
      return { ok: false, error: 'Not your turn' };
    }
    if (typeof from !== 'string' || typeof to !== 'string') {
      return { ok: false, error: 'Illegal move' };
    }
    const piece = this.chess.get(from);
    if (!piece || piece.color !== color) {
      return { ok: false, error: 'You have no piece on that square' };
    }

    // Default a required promotion to queen when the client omits it.
    let promo = promotion || undefined;
    const toRank = parseInt(to[1], 10);
    if (piece.type === 'p' && (toRank === 8 || toRank === 1) && !promo) {
      promo = 'q';
    }

    let move;
    try {
      // chess.js 1.x throws on an illegal move; older builds return null.
      move = this.chess.move({ from, to, promotion: promo });
    } catch (e) {
      move = null;
    }
    if (!move) return { ok: false, error: 'Illegal move' };

    // Build the full-info MoveRecord.
    let captureSquare = null;
    let capturedType = null;
    let capturedColor = null;
    if (move.captured) {
      capturedType = move.captured;
      capturedColor = color === 'w' ? 'b' : 'w';
      if (move.flags && move.flags.includes('e')) {
        // En passant: the captured pawn sits on the to-file, from-rank.
        captureSquare = to[0] + from[1];
      } else {
        captureSquare = move.to;
      }
    }

    const record = {
      ply: this.moveLog.length + 1,
      color,
      from: move.from,
      to: move.to,
      piece: move.piece,
      san: move.san,
      capture: !!move.captured,
      capturedType,
      capturedColor,
      captureSquare,
      promotion: move.promotion || null,
    };
    this.moveLog.push(record);
    this.turn = this.chess.turn();

    // End-of-game detection. isDraw() already covers stalemate-adjacent draws
    // (threefold, 50-move, insufficient material); stalemate is reported first.
    let ended = false;
    let result = null;
    if (this.chess.isCheckmate()) {
      ended = true;
      result = { result: 'checkmate', winner: color, reason: 'checkmate' };
    } else if (this.chess.isStalemate()) {
      ended = true;
      result = { result: 'stalemate', winner: null, reason: 'stalemate' };
    } else if (this.chess.isDraw()) {
      ended = true;
      result = { result: 'draw', winner: null, reason: 'draw' };
    }
    if (ended) {
      this.phase = 'ended';
      this.result = result;
    }

    return {
      ok: true,
      record,
      capture: move.captured
        ? { square: captureSquare, capturedType, capturedColor }
        : null,
      ended,
      result,
    };
  }

  // ---- resign / rematch ---------------------------------------------------

  resign(color) {
    if (this.phase !== 'playing') return { ok: false };
    this.phase = 'ended';
    this.result = {
      result: 'resign',
      winner: color === 'w' ? 'b' : 'w',
      reason: 'resign',
    };
    return { ok: true, result: this.result };
  }

  /**
   * rematch(color). Returns { both, by }. When both sides have requested, the
   * match state is reset to a fresh setup phase (colors retained).
   */
  rematch(color) {
    if (this.phase !== 'ended') return { both: false, by: color, ignored: true };
    this.rematch[FogChessGame.keyOf(color)] = true;
    if (this.rematch.white && this.rematch.black) {
      this.resetForRematch();
      return { both: true, by: color };
    }
    return { both: false, by: color };
  }

  /** ended -> setup, clearing per-game state but retaining player colors. */
  resetForRematch() {
    this.phase = 'setup';
    this.chess = null;
    this.arrangements = { white: null, black: null };
    this.ready = { white: false, black: false };
    this.rematch = { white: false, black: false };
    this.moveLog = [];
    this.turn = 'w';
    this.result = null;
    this.startFen = null;
  }

  // ---- per-viewer payload builders ---------------------------------------

  /** Build the CONTRACT section 6 `state` payload for a single viewer color. */
  buildState(viewerColor) {
    const role = FogChessGame.keyOf(viewerColor);
    const oppColor = viewerColor === 'w' ? 'b' : 'w';
    const oppKey = FogChessGame.keyOf(oppColor);

    let board = fog.emptyBoard();
    let moveLog = [];
    let inCheck = false;
    let checkSquare = null;

    if ((this.phase === 'playing' || this.phase === 'ended') && this.chess) {
      board = fog.filterBoard(this.chess, viewerColor);
      const ci = fog.checkInfoFor(this.chess, viewerColor);
      inCheck = ci.inCheck;
      checkSquare = ci.checkSquare;
      moveLog = this.moveLog.map((r) => fog.filterMoveRecord(r, viewerColor, this.config));
    }

    return {
      phase: this.phase,
      yourColor: viewerColor,
      yourRole: role,
      turn: this.turn,
      yourTurn: this.phase === 'playing' && this.turn === viewerColor,
      opponentConnected: this.socketOf(oppColor) !== null,
      yourReady: this.ready[role],
      opponentReady: this.ready[oppKey],
      inCheck,
      checkSquare,
      board,
      moveLog,
      result: this.result,
    };
  }

  /** Build the CONTRACT section 7 `gameOver` payload (full reveal). */
  buildGameOver() {
    const r = this.result || {};
    return {
      result: r.result,
      winner: r.winner === undefined ? null : r.winner,
      reason: r.reason,
      fullBoard: this.chess ? fog.revealBoard(this.chess) : fog.emptyBoard(),
      fen: this.chess ? this.chess.fen() : null,
    };
  }
}

module.exports = FogChessGame;
