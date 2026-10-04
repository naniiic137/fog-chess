'use strict';

// server.js
// Node adapter for Fog Chess: Express serves public/, and plain WebSockets (the
// `ws` package) at /ws?room=CODE carry the game. Every room code gets its own
// match (src/room.js), so many games can run at once; the match logic itself is
// shared with the Cloudflare adapter in worker/index.js.
//
// `createServer(options)` builds an isolated instance (used by the tests with a
// short reconnect window); running `node server.js` starts one on PORT.

const path = require('path');
const os = require('os');
const http = require('http');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

const { Room, isRoomCode, newRoomCode, MAX_MESSAGE_BYTES } = require('./src/room');
const FogChessGame = require('./src/game');

// Upper bound on live rooms, so a flood of made-up codes can't eat the memory.
const MAX_ROOMS = 1000;

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

/** Answer a WebSocket upgrade request with a plain HTTP error. */
function refuseUpgrade(socket, status, text) {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * createServer(options)
 *   revealCapturedPieceType (default true) - reveal a captured piece's type.
 *   reconnectGraceMs        (default 60000) - how long a dropped player's seat is
 *                                             held before they forfeit / lose it.
 * Returns { app, server, rooms, listen(port) -> Promise<port>, close() }.
 * `rooms` is the live Map of room code -> Room (src/room.js).
 */
function createServer(options) {
  const CONFIG = Object.assign(
    { revealCapturedPieceType: true, reconnectGraceMs: FogChessGame.DEFAULT_RECONNECT_GRACE_MS },
    options || {}
  );

  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  const rooms = new Map();

  app.use(express.static(path.join(__dirname, 'public')));

  // Join info for the waiting screen (LAN addresses the second player can open).
  app.get('/api/info', (req, res) => {
    const port = server.address() && server.address().port;
    res.json({ urls: lanUrls(port).slice(1), reconnectGraceMs: CONFIG.reconnectGraceMs });
  });

  // A new room code. The room itself is created when the first player connects.
  app.post('/api/rooms', (req, res) => {
    let room = newRoomCode();
    while (rooms.has(room)) room = newRoomCode();
    res.set('Cache-Control', 'no-store').json({ room });
  });

  /** The room for `code`, created on first use and forgotten once idle. */
  function getRoom(code) {
    let room = rooms.get(code);
    if (!room) {
      room = new Room(Object.assign({}, CONFIG, {
        onIdle() {
          // Everyone left and the reconnect window is over: free the room.
          if (rooms.get(code) === room) rooms.delete(code);
          room.dispose();
        },
      }));
      rooms.set(code, room);
    }
    return room;
  }

  // WebSocket endpoint: /ws?room=CODE
  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch (e) {
      refuseUpgrade(socket, 400, 'Bad Request');
      return;
    }
    if (url.pathname !== '/ws') {
      refuseUpgrade(socket, 404, 'Not Found');
      return;
    }
    const code = url.searchParams.get('room');
    if (!isRoomCode(code)) {
      refuseUpgrade(socket, 400, 'Bad Request');
      return;
    }
    if (!rooms.has(code) && rooms.size >= MAX_ROOMS) {
      refuseUpgrade(socket, 503, 'Service Unavailable');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => attach(ws, code));
  });

  /** Wire one WebSocket to its room. */
  function attach(ws, code) {
    const room = getRoom(code);
    const conn = {
      send(text) {
        if (ws.readyState === WebSocket.OPEN) ws.send(text);
      },
      close(closeCode, reason) {
        ws.close(closeCode, reason);
      },
    };
    room.open(conn);
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      room.receive(conn, data.toString('utf8'));
    });
    ws.on('close', () => room.close(conn));
    ws.on('error', () => room.close(conn));
  }

  function listen(port) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, () => resolve(server.address().port));
    });
  }

  function close() {
    for (const room of rooms.values()) room.dispose();
    rooms.clear();
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    return new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections(); // don't wait for idle keep-alive HTTP sockets
    });
  }

  return { app, server, rooms, listen, close };
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
