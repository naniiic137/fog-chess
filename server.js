'use strict';

// server.js
// Express static server + Socket.io wiring for Fog Chess. Serves public/ and the
// Socket.io client from /socket.io/socket.io.js (default). Implements the event
// contract in docs/CONTRACT.md + CONTRACT-v2.md (plus the reconnection additions
// documented in the README). All hidden-info filtering flows through src/fog.js.
//
// `createServer(options)` builds an isolated instance (used by the tests with a
// short reconnect window); running `node server.js` starts one on PORT.

const path = require('path');
const os = require('os');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const qrcode = require('qrcode-generator');

const FogChessGame = require('./src/game');
const fog = require('./src/fog');

/** Every non-internal IPv4 address as a URL, localhost first. */
function lanUrls(port) {
  const urls = [`http://localhost:${port}`];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      // Node <18 reports family as "IPv4"; newer builds may use the number 4.
      const isIPv4 = ni.family === 'IPv4' || ni.family === 4;
      if (isIPv4 && !ni.internal) {
        urls.push(`http://${ni.address}:${port}`);
      }
    }
  }
  return urls;
}

/**
 * createServer(options)
 *   revealCapturedPieceType (default true) - reveal a captured piece's type.
 *   reconnectGraceMs        (default 60000) - how long a dropped player's seat is
 *                                             held before they forfeit / lose it.
 * Returns { app, server, io, game, listen(port) -> Promise<port>, close() }.
 */
function createServer(options) {
  const CONFIG = Object.assign(
    { revealCapturedPieceType: true, reconnectGraceMs: FogChessGame.DEFAULT_RECONNECT_GRACE_MS },
    options || {}
  );

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);

  app.use(express.static(path.join(__dirname, 'public')));

  // Join info for the waiting screen (LAN addresses the second player can open).
  app.get('/api/info', (req, res) => {
    const port = server.address() && server.address().port;
    res.json({ urls: lanUrls(port).slice(1), reconnectGraceMs: CONFIG.reconnectGraceMs });
  });

  // QR code for the join link, generated locally (no external service).
  app.get('/qr.svg', (req, res) => {
    const text = typeof req.query.text === 'string' ? req.query.text : '';
    if (!/^https?:\/\/[^\s]{1,200}$/.test(text)) {
      res.status(400).type('text/plain').send('Expected ?text=<http(s) URL>');
      return;
    }
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    res.type('image/svg+xml').set('Cache-Control', 'no-store')
      .send(qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }));
  });

  // Single in-memory match (one game, no DB, no accounts).
  const game = new FogChessGame(CONFIG);

  // Reconnect-window timers, one per away seat.
  const awayTimers = { w: null, b: null };
  function clearAwayTimer(color) {
    if (awayTimers[color]) clearTimeout(awayTimers[color]);
    awayTimers[color] = null;
  }

  // ---- emit helpers -------------------------------------------------------

  function socketFor(color) {
    const id = game.socketOf(color);
    return id ? io.sockets.sockets.get(id) : null;
  }

  /** Per-viewer state (CONTRACT 11.4): each color gets its OWN filtered payload. */
  function emitStateToColor(color) {
    const s = socketFor(color);
    if (s) s.emit('state', game.buildState(color));
  }
  function emitState() {
    emitStateToColor('w');
    emitStateToColor('b');
  }

  /** Emit an event to the two player sockets only (never to a rejected 3rd). */
  function emitToBoth(event, payload) {
    const w = socketFor('w');
    const b = socketFor('b');
    if (w) w.emit(event, payload);
    if (b) b.emit(event, payload);
  }

  /** Broadcast the shared `config` (negotiation state) to both players. */
  function emitConfig() {
    emitToBoth('config', game.buildConfigPayload());
  }

  /** The reconnect window for `color` ran out. */
  function onAwayExpired(color) {
    awayTimers[color] = null;
    const res = game.expireSeat(color);
    if (!res) return;
    if (res.ended) emitToBoth('gameOver', game.buildGameOver());
    emitState();
  }

  // ---- connection handling ------------------------------------------------

  io.on('connection', (socket) => {
    const auth = (socket.handshake && socket.handshake.auth) || {};
    const seat = game.connect(socket.id, {
      token: typeof auth.token === 'string' ? auth.token : null,
      takeover: auth.takeover === true,
    });
    if (seat.rejected) {
      // Both seats taken (or held for a player who is reconnecting).
      socket.emit('rejected', { reason: seat.rejected });
      return;
    }

    if (seat.replaced) {
      // Same browser tab came back before its old socket timed out: retire it.
      const old = io.sockets.sockets.get(seat.replaced);
      if (old) {
        old.emit('rejected', { reason: 'replaced' });
        old.disconnect(true);
      }
    }
    clearAwayTimer(seat.color);

    socket.emit('assigned', {
      color: seat.color,
      role: seat.role,
      token: seat.token,
      resumed: seat.resumed,
    });
    const enteredConfig = game.maybeStartConfig();

    const oppColor = seat.color === 'w' ? 'b' : 'w';
    if (!game.socketOf(oppColor) && game.phase === 'lobby') {
      socket.emit('waiting', { message: 'Waiting for opponent to connect' });
    }
    // Authoritative snapshot to both (the opponent learns we (re)connected).
    emitState();
    // On entering the config phase (both seats filled), broadcast the live config;
    // a player resuming mid-negotiation gets the current proposal too.
    if (enteredConfig) emitConfig();
    else if (game.phase === 'config') socket.emit('config', game.buildConfigPayload());

    // ---- config: propose / agree (house-rules negotiation) ---------------
    socket.on('proposeConfig', (payload) => {
      const color = game.colorOf(socket.id);
      if (!color) return;
      const res = game.proposeConfig(color, payload && payload.config);
      if (!res.ok) return;
      emitConfig();
      emitState();
    });

    socket.on('agreeConfig', (payload) => {
      const color = game.colorOf(socket.id);
      if (!color) return;
      const version = payload ? payload.version : undefined;
      const res = game.agreeConfig(color, version);
      if (res.stale) {
        // Stale agree: resync the client with the current proposal.
        socket.emit('config', game.buildConfigPayload());
        return;
      }
      if (!res.ok && !res.started && !res.invalid) return;
      // Whether we advanced to setup, stayed (invalid), or just recorded an agree,
      // re-broadcast config; and push fresh state when the phase changed.
      emitConfig();
      if (res.started) emitState();
    });

    // ---- setup: submitArrangement ----------------------------------------
    socket.on('submitArrangement', (payload) => {
      const color = game.colorOf(socket.id);
      if (!color) return;
      const placement = payload && payload.placement;
      const res = game.submitArrangement(color, placement || {});
      if (!res.ok) {
        socket.emit('arrangementRejected', { reason: res.reason });
        return;
      }
      socket.emit('arrangementAccepted', { ok: true });
      if (res.started) {
        // Both arrangements in and the board is built.
        emitToBoth('gameStart', { turn: game.turn });
      }
      emitState();
    });

    // ---- requesting legal moves ------------------------------------------
    socket.on('requestMoves', (payload) => {
      const color = game.colorOf(socket.id);
      if (!color) return;
      const square = payload && payload.square;
      socket.emit('legalMoves', game.getLegalMoves(color, square));
    });

    // ---- making a move ----------------------------------------------------
    socket.on('makeMove', (payload) => {
      const color = game.colorOf(socket.id);
      if (!color) return;
      const from = payload && payload.from;
      const to = payload && payload.to;
      const promotion = payload ? payload.promotion : null;

      const res = game.makeMove(color, from, to, promotion);
      if (!res.ok) {
        socket.emit('errorMsg', { message: res.error || 'Illegal move' });
        return;
      }

      // Emit order per CONTRACT section 4:
      // 1. moveMade per-viewer (own = full entry, opponent = anonymized).
      for (const c of ['w', 'b']) {
        const s = socketFor(c);
        if (!s) continue;
        s.emit('moveMade', {
          entry: fog.filterMoveRecord(res.record, c, CONFIG),
          from: res.record.from,
          to: res.record.to,
        });
      }

      // 2. capture to both (only when a capture occurred and reveal is on).
      if (res.capture && CONFIG.revealCapturedPieceType) {
        emitToBoth('capture', {
          square: res.capture.square,
          capturedType: res.capture.capturedType,
          capturedColor: res.capture.capturedColor,
        });
      }

      // 3. check to the player now in check (that player only).
      for (const c of ['w', 'b']) {
        const ci = fog.checkInfoFor(game.chess, c);
        if (ci.inCheck) {
          const s = socketFor(c);
          if (s) s.emit('check', { inCheck: true, checkSquare: ci.checkSquare });
        }
      }

      // 4. authoritative per-viewer state snapshot.
      emitState();

      // 5. gameOver to both (only if the game ended).
      if (res.ended) {
        emitToBoth('gameOver', game.buildGameOver());
      }
    });

    // ---- resign -----------------------------------------------------------
    socket.on('resign', () => {
      const color = game.colorOf(socket.id);
      if (!color) return;
      const res = game.resign(color);
      if (!res.ok) return;
      // CONTRACT section 8: gameOver (full reveal) + state to both.
      emitToBoth('gameOver', game.buildGameOver());
      emitState();
    });

    // ---- rematch ----------------------------------------------------------
    socket.on('rematch', () => {
      const color = game.colorOf(socket.id);
      if (!color) return;
      const res = game.requestRematch(color);
      if (res.ignored) return;
      if (res.both) {
        // Reset complete: both return to a FRESH config phase (colors retained).
        emitState();
        emitConfig();
      } else {
        emitToBoth('rematchPending', { by: res.by });
      }
    });

    // ---- disconnect: hold the seat for the reconnect window ---------------
    socket.on('disconnect', () => {
      const res = game.handleDisconnect(socket.id);
      if (!res) return;
      clearAwayTimer(res.color);
      awayTimers[res.color] = setTimeout(() => onAwayExpired(res.color), game.reconnectGraceMs);
      // The remaining player sees "Opponent disconnected - waiting ...".
      emitState();
    });
  });

  function listen(port) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, () => resolve(server.address().port));
    });
  }

  function close() {
    clearAwayTimer('w');
    clearAwayTimer('b');
    return new Promise((resolve) => {
      io.close(() => resolve());
    });
  }

  return { app, server, io, game, listen, close };
}

module.exports = { createServer, lanUrls };

// ---- run directly: listen + LAN URL print ----------------------------------

if (require.main === module) {
  const PORT = parseInt(process.env.PORT, 10) || 3000;
  const graceSeconds = parseInt(process.env.RECONNECT_SECONDS, 10);
  const instance = createServer(
    Number.isFinite(graceSeconds) && graceSeconds >= 0 ? { reconnectGraceMs: graceSeconds * 1000 } : {}
  );
  instance.listen(PORT).then(() => {
    console.log('Fog Chess running at:');
    for (const u of lanUrls(PORT)) console.log(`  ${u}`);
  });
}
