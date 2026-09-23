'use strict';

// src/game.js
// GameState machine for the single Fog Chess match (v2).
//
// v1 responsibilities are unchanged: it holds the authoritative full-information
// chess.js instance for CLASSIC mode (server-only, NEVER emitted raw), the phase
// machine, players, arrangements, ready/rematch flags, and the full-info move log.
// Per-viewer filtering is delegated to src/fog.js.
//
// v2 adds: a `config` negotiation phase BEFORE setup; a second game MODE ("chaos")
// whose entire rules engine lives in src/chaos.js; and generalized variable-size
// boards. game.js contains NO movement math — it routes by mode. Classic remains
// behaviorally identical to v1 from `setup` onward.

const crypto = require('crypto');
const { Chess } = require('chess.js');
const { validateArrangement: validateClassicArrangement, buildFen, COMPOSITION } = require('./fen');
const fog = require('./fog');
const chaos = require('./chaos');

// Phase machine: lobby -> config -> setup -> playing -> ended (-> config on rematch).
//
// Seats & reconnection: each seat (white/black) is owned by a secret token that
// the server issues on first join and the browser keeps in storage. A socket that
// drops keeps its seat reserved for `reconnectGraceMs`; presenting the token again
// within that window resumes the seat (same color, same fogged view). Only when
// the window expires is the seat released - mid-game that is a loss by
// abandonment. game.js stores deadlines; server.js owns the actual timers.

const DEFAULT_RECONNECT_GRACE_MS = 60 * 1000;
const TOKEN_RE = /^[a-f0-9]{32}$/;

function newToken() {
  return crypto.randomBytes(16).toString('hex');
}

const CLASSIC_DIMS = { cols: 8, rows: 8 };

// The forced classic config (CONTRACT-v2 B.6). Any classic proposal is overwritten
// with this exact preset server-side.
function classicPreset() {
  return {
    mode: 'classic',
    boardDims: { cols: 8, rows: 8 },
    bannedTypes: [],
    roster: { p: 8, r: 2, n: 2, b: 2, q: 1, k: 1 },
    enabledFairy: [],
  };
}

class FogChessGame {
  constructor(options) {
    // `options` = server flags (e.g. revealCapturedPieceType). Distinct from the
    // negotiated house-rules `config`.
    this.options = Object.assign({ revealCapturedPieceType: true }, options || {});
    this.reconnectGraceMs = Number.isFinite(this.options.reconnectGraceMs)
      ? this.options.reconnectGraceMs
      : DEFAULT_RECONNECT_GRACE_MS;
    this.players = { white: null, black: null };   // connected socket id per seat
    this.tokens = { white: null, black: null };    // seat owner token (null = free seat)
    this.awayUntil = { white: null, black: null }; // reconnect deadline (ms epoch) while away
    this.gameCounter = 0;
    this.reset();
  }

  // Full reset back to an empty lobby (used by the constructor).
  reset() {
    this.phase = 'lobby'; // "lobby" | "config" | "setup" | "playing" | "ended"

    // Negotiated house rules (defaults to the classic preset so classic "just
    // works" via a trivial both-agree).
    this.config = classicPreset();
    this.agreed = { white: false, black: false };
    this.configVersion = 1;

    // Convenience mirrors of the agreed config.
    this.mode = this.config.mode;
    this.boardDims = { cols: this.config.boardDims.cols, rows: this.config.boardDims.rows };

    // Classic engine (full truth, server-only) / chaos board (full truth).
    this.chess = null;
    this.chaosBoard = null;

    this.arrangements = { white: null, black: null };
    this.ready = { white: false, black: false };
    this.rematch = { white: false, black: false };
    this.moveLog = []; // full-info MoveRecords; filtered per viewer at emit
    this.turn = 'w';
    this.result = null; // { result, winner, reason }
    this.startFen = null;
    this.gameId = null; // bumps every time a game starts (lets clients scope per-game data)
    // chaos draw tracking
    this.positionCounts = new Map();
    this.halfmoveClock = 0;
  }

  /** Forget both seats as well as the match (nobody left who could resume). */
  resetAll() {
    this.players = { white: null, black: null };
    this.tokens = { white: null, black: null };
    this.awayUntil = { white: null, black: null };
    this.reset();
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

  isChaos() {
    return this.mode === 'chaos';
  }

  // ---- connection / role assignment --------------------------------------

  /** Seat color owned by `token`, or null. */
  seatOfToken(token) {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
    if (this.tokens.white === token) return 'w';
    if (this.tokens.black === token) return 'b';
    return null;
  }

  isConnected(color) {
    return this.socketOf(color) !== null;
  }

  /**
   * connect(socketId, { token, takeover }) - seat a new socket.
   *   - token owns a seat that is away           -> resume it.
   *   - token owns a seat held by another socket -> resume only when `takeover`
   *     (the same browser tab reconnecting before the old socket timed out);
   *     the old socket id is returned as `replaced` so the server can drop it.
   *   - otherwise a newcomer: gets a free seat and a fresh token. After a game
   *     has ended, a newcomer may claim a seat whose owner is away, and the match
   *     restarts fresh so they never land on someone else's end screen.
   * Returns { color, role, token, resumed, replaced, fresh } or
   *         { rejected: 'full' | 'reconnecting' }.
   */
  connect(socketId, opts) {
    const o = opts || {};
    const tokenColor = this.seatOfToken(o.token);
    if (tokenColor) {
      const key = FogChessGame.keyOf(tokenColor);
      const current = this.players[key];
      if (current === null || o.takeover) {
        this.players[key] = socketId;
        this.awayUntil[key] = null;
        return {
          color: tokenColor, role: key, token: this.tokens[key], resumed: true,
          replaced: current && current !== socketId ? current : null, fresh: false,
        };
      }
      // Token already in use by a live socket (e.g. a second tab that copied it):
      // fall through and treat this socket as a newcomer.
    }

    let fresh = false;
    if (this.phase === 'ended') {
      const whiteLive = this.isConnected('w');
      const blackLive = this.isConnected('b');
      if (!whiteLive && !blackLive) {
        this.resetAll();
        fresh = true;
      } else if (!whiteLive || !blackLive) {
        const claim = whiteLive ? 'black' : 'white';
        this.tokens[claim] = null;
        this.awayUntil[claim] = null;
        this.resetForNewOpponent();
        fresh = true;
      }
    }

    for (const key of ['white', 'black']) {
      if (this.tokens[key] === null) {
        const token = newToken();
        this.tokens[key] = token;
        this.players[key] = socketId;
        this.awayUntil[key] = null;
        const color = key === 'white' ? 'w' : 'b';
        return { color, role: key, token, resumed: false, replaced: null, fresh };
      }
    }
    const someoneAway = this.awayUntil.white !== null || this.awayUntil.black !== null;
    return { rejected: someoneAway ? 'reconnecting' : 'full' };
  }

  /** Back-compat helper (tests / tools): seat a socket without a token. */
  addPlayer(socketId) {
    const res = this.connect(socketId, {});
    return res.rejected ? null : { color: res.color, role: res.role, token: res.token };
  }

  /** lobby -> config once both seats are taken. Returns true on transition. */
  maybeStartConfig() {
    if (this.phase === 'lobby' && this.tokens.white && this.tokens.black) {
      this.phase = 'config';
      return true;
    }
    return false;
  }

  /**
   * handleDisconnect(socketId, now) - the socket's seat stays RESERVED for
   * reconnectGraceMs. Nothing about the match changes yet.
   * Returns { color, awayUntil } or null when the socket held no seat (or was
   * already replaced by a newer socket for the same seat).
   */
  handleDisconnect(socketId, now) {
    const color = this.colorOf(socketId);
    if (!color) return null;
    const key = FogChessGame.keyOf(color);
    this.players[key] = null;
    this.awayUntil[key] = (now || Date.now()) + this.reconnectGraceMs;
    return { color, awayUntil: this.awayUntil[key] };
  }

  /**
   * expireSeat(color) - the reconnect window ran out: release the seat.
   *  - playing  -> the game ends; the other side wins by abandonment.
   *  - config / setup -> the remaining player drops back to the lobby.
   *  - nobody left at all -> full reset to an empty lobby.
   * Returns { ended } (ended = a game just finished by abandonment), or null
   * when the seat was not actually away (already resumed / released).
   */
  expireSeat(color) {
    const key = FogChessGame.keyOf(color);
    if (this.players[key] !== null || this.tokens[key] === null) return null;
    this.tokens[key] = null;
    this.awayUntil[key] = null;

    const otherKey = key === 'white' ? 'black' : 'white';
    if (!this.tokens[otherKey]) {
      // Nobody left who could resume or see a result: start over.
      this.resetAll();
      return { ended: false };
    }

    let ended = false;
    if (this.phase === 'playing') {
      this.phase = 'ended';
      this.result = {
        result: 'abandoned',
        winner: color === 'w' ? 'b' : 'w',
        reason: 'abandoned',
      };
      ended = true;
    } else if (this.phase === 'config' || this.phase === 'setup') {
      this.backToLobby();
    }
    return { ended };
  }

  /** config/setup -> lobby-wait: clear negotiation/setup progress. */
  backToLobby() {
    this.phase = 'lobby';
    this.agreed = { white: false, black: false };
    this.arrangements = { white: null, black: null };
    this.ready = { white: false, black: false };
    this.rematch = { white: false, black: false };
    this.chess = null;
    this.chaosBoard = null;
    this.moveLog = [];
    this.result = null;
  }

  /** ended -> fresh lobby for a NEW opponent (house rules back to classic). */
  resetForNewOpponent() {
    this.resetForRematch();
    this.config = classicPreset();
    this.mode = this.config.mode;
    this.boardDims = { cols: 8, rows: 8 };
    this.phase = 'lobby';
  }

  /** ms left in `color`'s reconnect window, or null when not away. */
  awayMsLeft(color, now) {
    const until = this.awayUntil[FogChessGame.keyOf(color)];
    if (until === null) return null;
    return Math.max(0, until - (now || Date.now()));
  }

  // ---- config / negotiation phase (CONTRACT-v2 C) ------------------------

  /** Sanitize a proposed config into the canonical shape (does not validate). */
  sanitizeConfig(raw) {
    const cfg = raw && typeof raw === 'object' ? raw : {};
    const mode = cfg.mode === 'chaos' ? 'chaos' : 'classic';
    if (mode === 'classic') {
      // Classic is forced to the exact preset (server overrides any tampering).
      return classicPreset();
    }

    const dimsIn = cfg.boardDims && typeof cfg.boardDims === 'object' ? cfg.boardDims : {};
    const cols = Number.isInteger(dimsIn.cols) ? dimsIn.cols : 8;
    const rows = Number.isInteger(dimsIn.rows) ? dimsIn.rows : 8;

    const enabledFairy = Array.isArray(cfg.enabledFairy)
      ? cfg.enabledFairy.filter((t) => chaos.FAIRY_TYPES.includes(t))
      : [];
    const bannedTypes = Array.isArray(cfg.bannedTypes)
      ? cfg.bannedTypes.filter((t) => !!chaos.CATALOG[t])
      : [];

    const roster = {};
    const rin = cfg.roster && typeof cfg.roster === 'object' ? cfg.roster : {};
    for (const t of Object.keys(rin)) {
      if (!chaos.CATALOG[t]) continue;
      const n = rin[t];
      if (!Number.isInteger(n) || n <= 0) continue;
      roster[t] = n;
    }

    return { mode: 'chaos', boardDims: { cols, rows }, bannedTypes, roster, enabledFairy };
  }

  /**
   * proposeConfig(color, rawConfig): replaces the shared config, bumps version,
   * and RESETS both agreements. Only meaningful in the config phase.
   * Returns { ok:true } or { ok:false }.
   */
  proposeConfig(color, rawConfig) {
    if (this.phase !== 'config') return { ok: false };
    this.config = this.sanitizeConfig(rawConfig);
    this.mode = this.config.mode;
    this.boardDims = { cols: this.config.boardDims.cols, rows: this.config.boardDims.rows };
    this.configVersion += 1;
    this.agreed = { white: false, black: false };
    return { ok: true };
  }

  /**
   * agreeConfig(color, version): the sender agrees to the CURRENT proposal.
   *  - version mismatch -> { stale:true } (server re-broadcasts config to resync).
   *  - both agreed & valid -> transition to setup, { started:true }.
   *  - both agreed & invalid -> stay in config, reset agreed, { invalid:true, error }.
   *  - otherwise -> { ok:true }.
   */
  agreeConfig(color, version) {
    if (this.phase !== 'config') return { ok: false };
    if (version !== this.configVersion) return { stale: true };

    this.agreed[FogChessGame.keyOf(color)] = true;
    if (!(this.agreed.white && this.agreed.black)) {
      return { ok: true };
    }

    const v = chaos.validateConfig(this.config);
    if (!v.valid) {
      this.agreed = { white: false, black: false };
      return { invalid: true, error: v.error };
    }

    // Both agreed on a valid config -> enter setup.
    this.startSetup();
    return { started: true };
  }

  /** config -> setup: lock the agreed config and prepare the setup holder. */
  startSetup() {
    this.mode = this.config.mode;
    this.boardDims = { cols: this.config.boardDims.cols, rows: this.config.boardDims.rows };
    this.phase = 'setup';
    this.chess = null;
    this.chaosBoard = null;
    this.arrangements = { white: null, black: null };
    this.ready = { white: false, black: false };
    this.moveLog = [];
    this.result = null;
    this.startFen = null;
    this.turn = 'w';
  }

  /** valid/error for the CURRENT config (drives the `config` broadcast). */
  configValidity() {
    return chaos.validateConfig(this.config);
  }

  /** Build the CONTRACT-v2 C `config` broadcast payload. */
  buildConfigPayload() {
    const v = this.configValidity();
    return {
      config: this.config,
      agreed: { white: this.agreed.white, black: this.agreed.black },
      version: this.configVersion,
      valid: v.valid,
      error: v.error || null,
    };
  }

  // ---- setup phase --------------------------------------------------------

  /** The roster for the current mode (classic uses the fixed composition). */
  currentRoster() {
    if (this.isChaos()) return this.config.roster;
    return Object.assign({}, COMPOSITION);
  }

  /** Home ranks for a viewer under the current mode/config. */
  homeRanksFor(color) {
    if (this.isChaos()) return chaos.homeRanks(this.config, color);
    return color === 'w' ? [1, 2] : [7, 8];
  }

  /** Promotion type options for the current mode. */
  promotionTypesFor() {
    if (this.isChaos()) return chaos.promotionTypes(this.config);
    return ['q', 'r', 'b', 'n'];
  }

  /**
   * submitArrangement(color, placement) — routes by mode.
   * Returns { ok:false, reason } or { ok:true, started }.
   */
  submitArrangement(color, placement) {
    if (this.phase !== 'setup') {
      return { ok: false, reason: 'Not in setup phase' };
    }

    let reason;
    if (this.isChaos()) {
      reason = chaos.validateArrangement(placement, color, this.config);
    } else {
      reason = validateClassicArrangement(placement, color);
    }
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

  /** setup -> playing. Routes board construction by mode. */
  startPlaying() {
    this.gameCounter += 1;
    this.gameId = this.gameCounter;
    this.positionCounts = new Map();
    this.halfmoveClock = 0;
    if (this.isChaos()) {
      this.chaosBoard = chaos.buildBoard(this.arrangements.white, this.arrangements.black, this.config);
      this.chess = null;
      this.startFen = null;
    } else {
      const fen = buildFen(this.arrangements.white, this.arrangements.black);
      this.chess = new Chess();
      this.chess.load(fen, { skipValidation: true }); // pawns may sit on rank 1/8
      this.startFen = fen;
      this.chaosBoard = null;
    }
    this.turn = 'w';
    this.phase = 'playing';
    if (this.isChaos()) {
      this.positionCounts.set(chaos.positionKey(this.chaosBoard, this.turn), 1);
    }
  }

  // ---- playing phase ------------------------------------------------------

  /**
   * getLegalMoves(color, square) -> { square, moves, hasMoves } (routes by mode).
   */
  getLegalMoves(color, square) {
    if (this.phase !== 'playing' || this.turn !== color) {
      return { square, moves: [], hasMoves: false };
    }
    if (typeof square !== 'string' || !chaos.SQUARE_RE.test(square)) {
      return { square, moves: [], hasMoves: false };
    }

    if (this.isChaos()) {
      const p = this.chaosBoard[square];
      if (!p || p.color !== color) return { square, moves: [], hasMoves: false };
      const moves = chaos.movesFrom(this.chaosBoard, square, this.boardDims);
      return { square, moves, hasMoves: moves.length > 0 };
    }

    // Classic (chess.js) path — unchanged from v1.
    if (!this.chess) return { square, moves: [], hasMoves: false };
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
   * makeMove(color, from, to, promotion) — routes by mode. Returns a uniform
   * result: { ok:false, error } or { ok:true, record, capture, ended, result }.
   */
  makeMove(color, from, to, promotion) {
    if (this.phase !== 'playing') {
      return { ok: false, error: 'Game not in progress' };
    }
    if (this.turn !== color) {
      return { ok: false, error: 'Not your turn' };
    }
    if (typeof from !== 'string' || typeof to !== 'string') {
      return { ok: false, error: 'Illegal move' };
    }
    return this.isChaos()
      ? this.makeMoveChaos(color, from, to, promotion)
      : this.makeMoveClassic(color, from, to, promotion);
  }

  /** Classic move application — v1 logic, unchanged (chess.js truth). */
  makeMoveClassic(color, from, to, promotion) {
    if (!this.chess) return { ok: false, error: 'Game not in progress' };
    const piece = this.chess.get(from);
    if (!piece || piece.color !== color) {
      return { ok: false, error: 'You have no piece on that square' };
    }

    let promo = promotion || undefined;
    const toRank = parseInt(to.slice(1), 10);
    if (piece.type === 'p' && (toRank === 8 || toRank === 1) && !promo) {
      promo = 'q';
    }

    let move;
    try {
      move = this.chess.move({ from, to, promotion: promo });
    } catch (e) {
      move = null;
    }
    if (!move) return { ok: false, error: 'Illegal move' };

    let captureSquare = null;
    let capturedType = null;
    let capturedColor = null;
    if (move.captured) {
      capturedType = move.captured;
      capturedColor = color === 'w' ? 'b' : 'w';
      if (move.flags && move.flags.includes('e')) {
        captureSquare = to[0] + from.slice(1);
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
      castle: move.flags && move.flags.includes('k') ? 'k'
        : (move.flags && move.flags.includes('q') ? 'q' : null),
    };
    this.moveLog.push(record);
    this.turn = this.chess.turn();

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
      let reason = 'draw';
      if (this.chess.isInsufficientMaterial()) reason = 'insufficientMaterial';
      else if (this.chess.isThreefoldRepetition()) reason = 'threefold';
      else if (this.chess.isDrawByFiftyMoves()) reason = 'fiftyMoves';
      result = { result: 'draw', winner: null, reason };
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

  /** Chaos move application — delegates all rules to chaos.applyMove. */
  makeMoveChaos(color, from, to, promotion) {
    const piece = this.chaosBoard[from];
    if (!piece || piece.color !== color) {
      return { ok: false, error: 'You have no piece on that square' };
    }

    const res = chaos.applyMove(this.chaosBoard, this.boardDims, this.config, color, from, to, promotion);
    if (!res.ok) return { ok: false, error: res.error };

    const capturedColor = res.captured ? res.captured.color : null;
    const capturedType = res.captured ? res.captured.type : null;
    const captureSquare = res.captured ? res.captured.square : null;

    const record = {
      ply: this.moveLog.length + 1,
      color,
      from,
      to,
      piece: res.movedType, // the piece type that moved (pre-promotion)
      san: null,            // no SAN engine in chaos
      capture: !!res.captured,
      capturedType,
      capturedColor,
      captureSquare,
      promotion: res.promotedTo || null,
    };
    this.moveLog.push(record);
    this.turn = color === 'w' ? 'b' : 'w';

    let ended = res.ended;
    let result = res.result;
    if (!ended) {
      // Draw rules: 50 moves each without a capture or pawn move, or the same
      // position (same side to move) for the third time.
      const pawnMove = !!(chaos.CATALOG[res.movedType] && chaos.CATALOG[res.movedType].pawn);
      this.halfmoveClock = res.captured || pawnMove ? 0 : this.halfmoveClock + 1;
      const key = chaos.positionKey(this.chaosBoard, this.turn);
      const seen = (this.positionCounts.get(key) || 0) + 1;
      this.positionCounts.set(key, seen);
      if (seen >= chaos.REPETITION_LIMIT) {
        ended = true;
        result = { result: 'draw', winner: null, reason: 'threefold' };
      } else if (this.halfmoveClock >= chaos.MOVE_LIMIT_PLIES) {
        ended = true;
        result = { result: 'draw', winner: null, reason: 'moveLimit' };
      }
    }

    if (ended) {
      this.phase = 'ended';
      this.result = result;
    }

    return {
      ok: true,
      record,
      capture: res.captured
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
   * requestRematch(color). Returns { both, by }. When both sides request, the
   * match resets to a FRESH config phase (CONTRACT-v2 E) so house rules can be
   * renegotiated. Colors are retained.
   */
  requestRematch(color) {
    if (this.phase !== 'ended') return { both: false, by: color, ignored: true };
    this.rematch[FogChessGame.keyOf(color)] = true;
    if (this.rematch.white && this.rematch.black) {
      this.resetForRematch();
      return { both: true, by: color };
    }
    return { both: false, by: color };
  }

  /** ended -> config (fresh negotiation), retaining the last agreed config + colors. */
  resetForRematch() {
    this.phase = 'config';
    this.chess = null;
    this.chaosBoard = null;
    this.arrangements = { white: null, black: null };
    this.ready = { white: false, black: false };
    this.rematch = { white: false, black: false };
    this.agreed = { white: false, black: false };
    this.configVersion += 1; // invalidate any stale agree
    this.moveLog = [];
    this.turn = 'w';
    this.result = null;
    this.startFen = null;
    // this.config / this.mode / this.boardDims retained so the screen is prefilled.
  }

  // ---- per-viewer payload builders ---------------------------------------

  /** The board source for fog filtering under the current mode. */
  boardSource() {
    if (this.isChaos()) return this.chaosBoard ? chaos.boardSource(this.chaosBoard) : null;
    return this.chess;
  }

  /** Build the `state` payload for a single viewer color (CONTRACT-v2 D). */
  buildState(viewerColor) {
    const role = FogChessGame.keyOf(viewerColor);
    const oppColor = viewerColor === 'w' ? 'b' : 'w';
    const oppKey = FogChessGame.keyOf(oppColor);

    let board = fog.emptyBoard(this.boardDims);
    let moveLog = [];
    let inCheck = false;
    let checkSquare = null;
    const ended = this.phase === 'ended';

    if ((this.phase === 'playing' || ended)) {
      const src = this.boardSource();
      if (src) {
        board = fog.filterBoard(src, viewerColor, this.boardDims);
        // Once the game is over every piece is revealed anyway (gameOver), so the
        // log names the opponent's pieces too. While playing it stays anonymized.
        moveLog = ended
          ? this.moveLog.map((r) => fog.revealMoveRecord(r, viewerColor))
          : this.moveLog.map((r) => fog.filterMoveRecord(r, viewerColor, this.options));
      }
      if (!this.isChaos()) {
        const ci = fog.checkInfoFor(this.chess, viewerColor);
        inCheck = ci.inCheck;
        checkSquare = ci.checkSquare;
      }
    }

    const state = {
      phase: this.phase,
      yourColor: viewerColor,
      yourRole: role,
      mode: this.mode,
      boardDims: { cols: this.boardDims.cols, rows: this.boardDims.rows },

      config: this.config,
      agreed: { white: this.agreed.white, black: this.agreed.black },
      configVersion: this.configVersion,

      turn: this.turn,
      yourTurn: this.phase === 'playing' && this.turn === viewerColor,
      opponentConnected: this.socketOf(oppColor) !== null,
      // ms left before an away opponent forfeits (null = not away).
      opponentAwayMs: this.awayMsLeft(oppColor),
      reconnectGraceMs: this.reconnectGraceMs,
      gameId: this.gameId,
      lastMove: this.lastMove(),
      yourReady: this.ready[role],
      opponentReady: this.ready[oppKey],
      inCheck,
      checkSquare,
      board,
      moveLog,
      result: this.result,
    };

    // Ended: carry the full reveal in the state itself, so a player who reloads
    // after the game is over still gets the unfogged final board.
    if (ended) state.gameOver = this.buildGameOver();

    if (this.phase === 'setup') {
      state.setup = {
        roster: this.currentRoster(),
        boardDims: { cols: this.boardDims.cols, rows: this.boardDims.rows },
        homeRanks: this.homeRanksFor(viewerColor),
        bannedTypes: this.isChaos() ? (this.config.bannedTypes || []) : [],
        enabledFairy: this.isChaos() ? (this.config.enabledFairy || []) : [],
        promotionTypes: this.promotionTypesFor(),
      };
    }

    return state;
  }

  /** { from, to } of the latest move (squares only - already public to both). */
  lastMove() {
    const last = this.moveLog[this.moveLog.length - 1];
    return last ? { from: last.from, to: last.to } : null;
  }

  /** Build the `gameOver` payload (full reveal). Chaos fen is null. */
  buildGameOver() {
    const r = this.result || {};
    const src = this.boardSource();
    const fullBoard = src ? fog.revealBoard(src, this.boardDims) : fog.emptyBoard(this.boardDims);
    return {
      result: r.result,
      winner: r.winner === undefined ? null : r.winner,
      reason: r.reason,
      fullBoard,
      fen: this.isChaos() ? null : (this.chess ? this.chess.fen() : null),
    };
  }
}

FogChessGame.DEFAULT_RECONNECT_GRACE_MS = DEFAULT_RECONNECT_GRACE_MS;
module.exports = FogChessGame;
