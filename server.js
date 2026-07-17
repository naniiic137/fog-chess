'use strict';

// server.js
// Express static server + Socket.io wiring for Fog Chess. Serves public/ and the
// Socket.io client from /socket.io/socket.io.js (default). Implements EXACTLY the
// event contract in CONTRACT.md. All hidden-info filtering flows through src/fog.js.

const path = require('path');
const os = require('os');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const FogChessGame = require('./src/game');
const fog = require('./src/fog');

// Config flags (CONTRACT default: revealCapturedPieceType true).
const CONFIG = { revealCapturedPieceType: true };
const PORT = parseInt(process.env.PORT, 10) || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Single in-memory match (v1: one game, no DB, no accounts).
const game = new FogChessGame(CONFIG);

// ---- emit helpers ---------------------------------------------------------

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

// ---- connection handling --------------------------------------------------

io.on('connection', (socket) => {
  const assigned = game.addPlayer(socket.id);
  if (!assigned) {
    // Third+ connection: both slots taken.
    socket.emit('rejected', { reason: 'full' });
    return;
  }

  socket.emit('assigned', assigned);
  game.maybeStartSetup();

  const oppColor = assigned.color === 'w' ? 'b' : 'w';
  if (!game.socketOf(oppColor)) {
    socket.emit('waiting', { message: 'Waiting for opponent to connect' });
  }
  // Authoritative snapshot to both (opponent, if present, learns we connected).
  emitState();

  // ---- setup: submitArrangement ------------------------------------------
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

  // ---- requesting legal moves --------------------------------------------
  socket.on('requestMoves', (payload) => {
    const color = game.colorOf(socket.id);
    if (!color) return;
    const square = payload && payload.square;
    socket.emit('legalMoves', game.getLegalMoves(color, square));
  });

  // ---- making a move ------------------------------------------------------
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

  // ---- resign -------------------------------------------------------------
  socket.on('resign', () => {
    const color = game.colorOf(socket.id);
    if (!color) return;
    const res = game.resign(color);
    if (!res.ok) return;
    // CONTRACT section 8: gameOver (full reveal) + state to both.
    emitToBoth('gameOver', game.buildGameOver());
    emitState();
  });

  // ---- rematch ------------------------------------------------------------
  socket.on('rematch', () => {
    const color = game.colorOf(socket.id);
    if (!color) return;
    const res = game.requestRematch(color);
    if (res.ignored) return;
    if (res.both) {
      // Reset complete: fresh setup state to both (colors retained).
      emitState();
    } else {
      emitToBoth('rematchPending', { by: res.by });
    }
  });

  // ---- disconnect (minimal; reconnect out of scope) ----------------------
  socket.on('disconnect', () => {
    const res = game.handleDisconnect(socket.id);
    if (!res) return;
    if (res.ended) {
      // Notify the remaining peer with the full reveal + ended state.
      emitToBoth('gameOver', game.buildGameOver());
    }
    emitState();
  });
});

// ---- listen + LAN URL print ----------------------------------------------

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

server.listen(PORT, () => {
  const urls = lanUrls(PORT);
  console.log('Fog Chess running at:');
  for (const u of urls) console.log(`  ${u}`);
});
