'use strict';

// src/room.js
// One match room, independent of the transport. Both adapters - server.js (Node +
// the `ws` package) and worker/index.js (a Cloudflare Durable Object) - create a
// Room per room code and feed it raw WebSocket text; the Room owns the match
// (src/game.js), the per-connection seat handshake, the reconnect timers and
// every emit. All hidden-info filtering still flows through src/fog.js.
//
// A connection (`conn`) is any object with:
//   send(text)          - send one text frame
//   close(code, reason) - close the socket (the adapter then calls room.close(conn))
//
// Wire format (JSON text frames):
//   client -> server  { t: event, d: data, id?: ackId }
//   server -> client  { t: event, d: data }   and acks  { ack: id, d: data }
// The first client message must be `hello` ({ token?, takeover? }); it plays the
// part of the old socket.io handshake `auth`. Everything before it is ignored.

const FogChessGame = require('./game');
const fog = require('./fog');

// ---- room codes --------------------------------------------------------------

// No 0/O, 1/I or L: easy to read out loud and to type from a phone.
const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const ROOM_CODE_LENGTH = 6;
const ROOM_CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{6}$/;

function isRoomCode(code) {
  return typeof code === 'string' && ROOM_CODE_RE.test(code);
}

/** A fresh random room code (Web Crypto: works in Node 20+ and Workers). */
function newRoomCode() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(ROOM_CODE_LENGTH * 2));
  let code = '';
  for (let i = 0; i < bytes.length && code.length < ROOM_CODE_LENGTH; i++) {
    // Rejection sampling keeps every character equally likely.
    if (bytes[i] < 248) code += ROOM_ALPHABET[bytes[i] % ROOM_ALPHABET.length];
  }
  return code.length === ROOM_CODE_LENGTH ? code : newRoomCode();
}

// ---- limits ------------------------------------------------------------------

const MAX_MESSAGE_BYTES = 16 * 1024;  // a full 10x10 arrangement is well under 2 KB
const HELLO_TIMEOUT_MS = 10 * 1000;   // a socket that never says hello is dropped
const RATE_WINDOW_MS = 10 * 1000;     // at most RATE_MAX messages per window ...
const RATE_MAX = 200;                 // ... per connection; extra ones are ignored
const DEAD_AFTER_MS = 45 * 1000;      // no message (clients ping every 15 s) -> dropped
const SWEEP_MS = 15 * 1000;

// Close codes in the 4000-4999 range tell net.js NOT to reconnect (only codes
// 1000 and 3000-4999 may be sent by the server on every platform).
const CLOSE_REJECTED = 4001;
const CLOSE_NO_HELLO = 4002;
const CLOSE_TOO_BIG = 4003;

// ---- payload checks (never trust the client) ---------------------------------

const SQUARE_RE = /^[a-z][0-9]{1,2}$/;
const TYPE_RE = /^[a-z]$/;
const TOKEN_RE = /^[a-f0-9]{32}$/;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isSquare(v) {
  return typeof v === 'string' && SQUARE_RE.test(v);
}

function isTypeList(v) {
  return Array.isArray(v) && v.length <= 32 && v.every((t) => typeof t === 'string' && TYPE_RE.test(t));
}

/** Shape check for a proposed config; game.js then sanitizes and validates it. */
function isConfigShape(cfg) {
  if (!isPlainObject(cfg)) return false;
  if (cfg.mode !== 'classic' && cfg.mode !== 'chaos') return false;
  if (cfg.boardDims !== undefined) {
    if (!isPlainObject(cfg.boardDims)) return false;
    if (!Number.isInteger(cfg.boardDims.cols) || !Number.isInteger(cfg.boardDims.rows)) return false;
  }
  if (cfg.bannedTypes !== undefined && !isTypeList(cfg.bannedTypes)) return false;
  if (cfg.enabledFairy !== undefined && !isTypeList(cfg.enabledFairy)) return false;
  if (cfg.roster !== undefined) {
    if (!isPlainObject(cfg.roster)) return false;
    const keys = Object.keys(cfg.roster);
    if (keys.length > 32) return false;
    for (const t of keys) {
      const n = cfg.roster[t];
      if (!TYPE_RE.test(t) || !Number.isInteger(n) || n < 0 || n > 100) return false;
    }
  }
  return true;
}

/** Shape check for a setup placement: { square: pieceType }. */
function isPlacementShape(p) {
  if (!isPlainObject(p)) return false;
  const keys = Object.keys(p);
  if (keys.length > 100) return false;
  return keys.every((sq) => SQUARE_RE.test(sq) && typeof p[sq] === 'string' && TYPE_RE.test(p[sq]));
}

/** Parse one raw frame -> { t, d, id } or null when it is not a valid message. */
function parseMessage(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_MESSAGE_BYTES) return null;
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch (e) {
    return null;
  }
  if (!isPlainObject(msg) || typeof msg.t !== 'string' || msg.t.length > 32) return null;
  const id = Number.isInteger(msg.id) && msg.id > 0 ? msg.id : null;
  return { t: msg.t, d: msg.d === undefined ? null : msg.d, id };
}

// ---- the room ----------------------------------------------------------------

/**
 * new Room(options)
 *   revealCapturedPieceType (default true)  - reveal a captured piece's type.
 *   reconnectGraceMs        (default 60000) - how long a dropped player's seat is
 *                                             held before they forfeit / lose it.
 *   onIdle()                                - called when nobody is connected and
 *                                             no seat is held (the adapter may then
 *                                             forget the room).
 */
class Room {
  constructor(options) {
    const o = options || {};
    this.config = {
      revealCapturedPieceType: o.revealCapturedPieceType !== false,
      reconnectGraceMs: Number.isFinite(o.reconnectGraceMs)
        ? o.reconnectGraceMs
        : FogChessGame.DEFAULT_RECONNECT_GRACE_MS,
    };
    this.onIdle = typeof o.onIdle === 'function' ? o.onIdle : null;
    this.deadAfterMs = Number.isFinite(o.deadAfterMs) ? o.deadAfterMs : DEAD_AFTER_MS;

    // Single in-memory match per room (no DB, no accounts).
    this.game = new FogChessGame(this.config);
    this.conns = new Map(); // conn id -> conn
    this.nextConnId = 1;
    this.awayTimers = { w: null, b: null }; // reconnect-window timers, one per away seat
    this.sweepTimer = null;
  }

  // ---- connection lifecycle ----------------------------------------------

  /** A socket opened. It gets a seat only after its `hello`. */
  open(conn) {
    conn.id = 'c' + this.nextConnId++;
    conn.hello = false;
    conn.lastSeen = Date.now();
    conn.rateStart = conn.lastSeen;
    conn.rateCount = 0;
    conn.helloTimer = setTimeout(() => {
      if (!conn.hello) this.kick(conn, CLOSE_NO_HELLO, 'no hello');
    }, HELLO_TIMEOUT_MS);
    this.conns.set(conn.id, conn);
    this.startSweep();
  }

  /** Raw text frame from `conn`: parse, rate-limit and dispatch. */
  receive(conn, raw) {
    if (!this.conns.has(conn.id)) return;
    if (typeof raw !== 'string' || raw.length > MAX_MESSAGE_BYTES) {
      this.kick(conn, CLOSE_TOO_BIG, 'message too big');
      return;
    }
    const now = Date.now();
    conn.lastSeen = now;
    if (now - conn.rateStart > RATE_WINDOW_MS) {
      conn.rateStart = now;
      conn.rateCount = 0;
    }
    if (++conn.rateCount > RATE_MAX) return;

    const msg = parseMessage(raw);
    if (!msg) return;
    const ack = msg.id === null ? null : (d) => this.sendRaw(conn, { ack: msg.id, d: d === undefined ? null : d });
    this.message(conn, msg.t, msg.d, ack);
  }

  /** One decoded event. Unknown events, and anything before `hello`, are ignored. */
  message(conn, event, data, ack) {
    if (!this.conns.has(conn.id)) return;
    if (event === 'ping') {
      if (ack) ack({});
      return;
    }
    if (event === 'hello') {
      this.hello(conn, data);
      return;
    }
    if (!conn.hello) return;
    const handler = Object.prototype.hasOwnProperty.call(HANDLERS, event) ? HANDLERS[event] : null;
    if (!handler) return;
    const color = this.game.colorOf(conn.id);
    if (!color) return;
    handler.call(this, conn, color, isPlainObject(data) ? data : {}, ack);
  }

  /** The socket closed (or was dropped). Holds its seat for the reconnect window. */
  close(conn) {
    if (!this.conns.has(conn.id)) return;
    this.conns.delete(conn.id);
    clearTimeout(conn.helloTimer);
    if (this.conns.size === 0) this.stopSweep();

    const res = this.game.handleDisconnect(conn.id);
    if (res) {
      this.clearAwayTimer(res.color);
      this.awayTimers[res.color] = setTimeout(() => this.onAwayExpired(res.color), this.game.reconnectGraceMs);
      // The remaining player sees "Opponent disconnected - waiting ...".
      this.emitState();
    }
    this.checkIdle();
  }

  /** Close a socket from our side and forget it right away. */
  kick(conn, code, reason) {
    try {
      conn.close(code, reason);
    } catch (e) {
      // already closed
    }
    this.close(conn);
  }

  /** True when nobody is connected and no seat is held. */
  isIdle() {
    return this.conns.size === 0 && !this.game.tokens.white && !this.game.tokens.black;
  }

  checkIdle() {
    if (this.onIdle && this.isIdle()) this.onIdle();
  }

  /** Stop every timer (the adapter is throwing this room away). */
  dispose() {
    this.clearAwayTimer('w');
    this.clearAwayTimer('b');
    this.stopSweep();
    for (const conn of this.conns.values()) clearTimeout(conn.helloTimer);
  }

  // Drop sockets that went silent (laptop lid closed, phone lost signal, ...),
  // so the opponent sees them as away instead of waiting forever.
  startSweep() {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      const cutoff = Date.now() - this.deadAfterMs;
      for (const conn of [...this.conns.values()]) {
        if (conn.lastSeen < cutoff) this.kick(conn, 1000, 'timed out');
      }
    }, Math.min(SWEEP_MS, this.deadAfterMs));
  }

  stopSweep() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  clearAwayTimer(color) {
    if (this.awayTimers[color]) clearTimeout(this.awayTimers[color]);
    this.awayTimers[color] = null;
  }

  /** The reconnect window for `color` ran out. */
  onAwayExpired(color) {
    this.awayTimers[color] = null;
    const res = this.game.expireSeat(color);
    if (!res) return;
    if (res.ended) this.emitToBoth('gameOver', this.game.buildGameOver());
    this.emitState();
    this.checkIdle();
  }

  // ---- emit helpers --------------------------------------------------------

  sendRaw(conn, obj) {
    try {
      conn.send(JSON.stringify(obj));
    } catch (e) {
      // socket already gone; its close handler cleans up
    }
  }

  emit(conn, event, data) {
    this.sendRaw(conn, { t: event, d: data === undefined ? null : data });
  }

  connFor(color) {
    const id = this.game.socketOf(color);
    return id ? this.conns.get(id) || null : null;
  }

  /** Per-viewer state (CONTRACT 11.4): each color gets its OWN filtered payload. */
  emitStateToColor(color) {
    const c = this.connFor(color);
    if (c) this.emit(c, 'state', this.game.buildState(color));
  }

  emitState() {
    this.emitStateToColor('w');
    this.emitStateToColor('b');
  }

  /** Emit an event to the two seated players only (never to a rejected 3rd). */
  emitToBoth(event, payload) {
    const w = this.connFor('w');
    const b = this.connFor('b');
    if (w) this.emit(w, event, payload);
    if (b) this.emit(b, event, payload);
  }

  /** Broadcast the shared `config` (negotiation state) to both players. */
  emitConfig() {
    this.emitToBoth('config', this.game.buildConfigPayload());
  }

  // ---- hello: seat the socket (the old socket.io handshake) ----------------

  hello(conn, data) {
    if (conn.hello) return; // once per socket
    conn.hello = true;
    clearTimeout(conn.helloTimer);
    const game = this.game;
    const auth = isPlainObject(data) ? data : {};
    const seat = game.connect(conn.id, {
      token: typeof auth.token === 'string' && TOKEN_RE.test(auth.token) ? auth.token : null,
      takeover: auth.takeover === true,
    });
    if (seat.rejected) {
      // Both seats taken (or held for a player who is reconnecting).
      this.emit(conn, 'rejected', { reason: seat.rejected });
      this.kick(conn, CLOSE_REJECTED, seat.rejected);
      return;
    }

    if (seat.replaced) {
      // Same browser tab came back before its old socket timed out: retire it.
      const old = this.conns.get(seat.replaced);
      if (old) {
        this.emit(old, 'rejected', { reason: 'replaced' });
        this.kick(old, CLOSE_REJECTED, 'replaced');
      }
    }
    this.clearAwayTimer(seat.color);

    this.emit(conn, 'assigned', {
      color: seat.color,
      role: seat.role,
      token: seat.token,
      resumed: seat.resumed,
    });
    const enteredConfig = game.maybeStartConfig();

    const oppColor = seat.color === 'w' ? 'b' : 'w';
    if (!game.socketOf(oppColor) && game.phase === 'lobby') {
      this.emit(conn, 'waiting', { message: 'Waiting for opponent to connect' });
    }
    // Authoritative snapshot to both (the opponent learns we (re)connected).
    this.emitState();
    // On entering the config phase (both seats filled), broadcast the live config;
    // a player resuming mid-negotiation gets the current proposal too.
    if (enteredConfig) this.emitConfig();
    else if (game.phase === 'config') this.emit(conn, 'config', game.buildConfigPayload());
  }
}

// ---- event handlers: (conn, color, data, ack), `this` = the Room --------------

const HANDLERS = {
  // ---- config: propose / agree (house-rules negotiation) -----------------
  proposeConfig(conn, color, data) {
    if (!isConfigShape(data.config)) return;
    const res = this.game.proposeConfig(color, data.config);
    if (!res.ok) return;
    this.emitConfig();
    this.emitState();
  },

  agreeConfig(conn, color, data) {
    if (!Number.isInteger(data.version)) return;
    const res = this.game.agreeConfig(color, data.version);
    if (res.stale) {
      // Stale agree: resync the client with the current proposal.
      this.emit(conn, 'config', this.game.buildConfigPayload());
      return;
    }
    if (!res.ok && !res.started && !res.invalid) return;
    // Whether we advanced to setup, stayed (invalid), or just recorded an agree,
    // re-broadcast config; and push fresh state when the phase changed.
    this.emitConfig();
    if (res.started) this.emitState();
  },

  // ---- setup: submitArrangement ------------------------------------------
  submitArrangement(conn, color, data) {
    if (!isPlacementShape(data.placement)) {
      this.emit(conn, 'arrangementRejected', { reason: 'Invalid placement object' });
      return;
    }
    const res = this.game.submitArrangement(color, data.placement);
    if (!res.ok) {
      this.emit(conn, 'arrangementRejected', { reason: res.reason });
      return;
    }
    this.emit(conn, 'arrangementAccepted', { ok: true });
    if (res.started) {
      // Both arrangements in and the board is built.
      this.emitToBoth('gameStart', { turn: this.game.turn });
    }
    this.emitState();
  },

  // ---- requesting legal moves --------------------------------------------
  requestMoves(conn, color, data) {
    if (!isSquare(data.square)) return;
    this.emit(conn, 'legalMoves', this.game.getLegalMoves(color, data.square));
  },

  // ---- making a move -------------------------------------------------------
  makeMove(conn, color, data) {
    const { from, to } = data;
    const promotion = data.promotion === undefined || data.promotion === null ? null : data.promotion;
    if (!isSquare(from) || !isSquare(to) || (promotion !== null && !(typeof promotion === 'string' && TYPE_RE.test(promotion)))) {
      this.emit(conn, 'errorMsg', { message: 'Illegal move' });
      return;
    }

    const game = this.game;
    const res = game.makeMove(color, from, to, promotion);
    if (!res.ok) {
      this.emit(conn, 'errorMsg', { message: res.error || 'Illegal move' });
      return;
    }

    // Emit order per CONTRACT section 4:
    // 1. moveMade per-viewer (own = full entry, opponent = anonymized).
    for (const c of ['w', 'b']) {
      const s = this.connFor(c);
      if (!s) continue;
      this.emit(s, 'moveMade', {
        entry: fog.filterMoveRecord(res.record, c, this.config),
        from: res.record.from,
        to: res.record.to,
      });
    }

    // 2. capture to both (only when a capture occurred and reveal is on).
    if (res.capture && this.config.revealCapturedPieceType) {
      this.emitToBoth('capture', {
        square: res.capture.square,
        capturedType: res.capture.capturedType,
        capturedColor: res.capture.capturedColor,
      });
    }

    // 3. check to the player now in check (that player only).
    for (const c of ['w', 'b']) {
      const ci = fog.checkInfoFor(game.chess, c);
      if (ci.inCheck) {
        const s = this.connFor(c);
        if (s) this.emit(s, 'check', { inCheck: true, checkSquare: ci.checkSquare });
      }
    }

    // 4. authoritative per-viewer state snapshot.
    this.emitState();

    // 5. gameOver to both (only if the game ended).
    if (res.ended) {
      this.emitToBoth('gameOver', game.buildGameOver());
    }
  },

  // ---- resign --------------------------------------------------------------
  resign(conn, color) {
    const res = this.game.resign(color);
    if (!res.ok) return;
    // CONTRACT section 8: gameOver (full reveal) + state to both.
    this.emitToBoth('gameOver', this.game.buildGameOver());
    this.emitState();
  },

  // ---- rematch -------------------------------------------------------------
  rematch(conn, color) {
    const res = this.game.requestRematch(color);
    if (res.ignored) return;
    if (res.both) {
      // Reset complete: both return to a FRESH config phase (colors retained).
      this.emitState();
      this.emitConfig();
    } else {
      this.emitToBoth('rematchPending', { by: res.by });
    }
  },
};

module.exports = {
  Room,
  isRoomCode,
  newRoomCode,
  parseMessage,
  ROOM_CODE_RE,
  MAX_MESSAGE_BYTES,
};
