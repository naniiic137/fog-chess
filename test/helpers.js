'use strict';

// Shared helpers for the socket-level tests: spin up an isolated server on a
// random port, open plain WebSocket clients (the `ws` package, speaking the same
// JSON protocol as public/net.js) that record every event, and drive a classic
// game up to the playing phase.

const WebSocket = require('ws');
const { createServer } = require('../server');

async function startServer(options) {
  const instance = createServer(options);
  const port = await instance.listen(0);
  return { ...instance, url: `http://127.0.0.1:${port}` };
}

/** Ask the server for a fresh room code. */
async function newRoom(srv) {
  const res = await fetch(`${srv.url}/api/rooms`, { method: 'POST' });
  const body = await res.json();
  return body.room;
}

/** WebSocket URL of a room (no validation, so tests can send bad codes too). */
function wsUrl(srv, room) {
  return `${srv.url.replace(/^http/, 'ws')}/ws?room=${encodeURIComponent(room)}`;
}

/**
 * connect(srv, room, auth) -> client. Sends `hello` with `auth` on open.
 * `client.waitFor(event, pred)` resolves with the first not-yet-consumed payload
 * of `event` matching `pred`, whether it already arrived or arrives later.
 * `client.closed` resolves with the close code once the socket is closed.
 */
function connect(srv, room, auth) {
  const ws = new WebSocket(wsUrl(srv, room));
  const client = { ws, log: [], handlers: new Set(), nextAck: 1, acks: new Map() };
  const queue = [];

  client.send = (obj) => {
    const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
    if (ws.readyState === WebSocket.OPEN) ws.send(text);
    else queue.push(text);
  };
  client.emit = (event, data) => client.send({ t: event, d: data === undefined ? null : data });
  /** Emit with an ack id; resolves with the ack payload. */
  client.request = (event, data) => new Promise((resolve) => {
    const id = client.nextAck++;
    client.acks.set(id, resolve);
    client.send({ t: event, d: data === undefined ? null : data, id });
  });

  ws.on('open', () => {
    if (auth !== false) ws.send(JSON.stringify({ t: 'hello', d: auth || {} }));
    while (queue.length) ws.send(queue.shift());
  });
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.ack !== undefined) {
      const done = client.acks.get(msg.ack);
      client.acks.delete(msg.ack);
      if (done) done(msg.d);
      return;
    }
    const entry = { event: msg.t, payload: msg.d, used: false };
    client.log.push(entry);
    for (const h of [...client.handlers]) h(entry);
  });
  client.closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
  ws.on('error', () => {});

  client.waitFor = (event, pred, ms) => {
    const test = pred || (() => true);
    return new Promise((resolve, reject) => {
      const found = client.log.find((e) => !e.used && e.event === event && test(e.payload));
      if (found) {
        found.used = true;
        resolve(found.payload);
        return;
      }
      const timer = setTimeout(() => {
        client.handlers.delete(handler);
        reject(new Error(`timed out waiting for "${event}"`));
      }, ms || 3000);
      function handler(entry) {
        if (entry.used || entry.event !== event || !test(entry.payload)) return;
        clearTimeout(timer);
        client.handlers.delete(handler);
        entry.used = true;
        resolve(entry.payload);
      }
      client.handlers.add(handler);
    });
  };

  /** Latest `state` received so far (or null). */
  client.lastState = () => {
    for (let i = client.log.length - 1; i >= 0; i--) {
      if (client.log[i].event === 'state') return client.log[i].payload;
    }
    return null;
  };

  client.close = () => ws.close();
  return client;
}

/** Open a raw upgrade to `url` and resolve with the HTTP status it was refused with (or 101). */
function upgradeStatus(url) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.on('unexpected-response', (req, res) => {
      resolve(res.statusCode);
      req.destroy();
    });
    ws.on('open', () => {
      resolve(101);
      ws.close();
    });
    ws.on('error', () => {});
  });
}

function standardPlacement(color) {
  const back = color === 'w' ? 1 : 8;
  const pawns = color === 'w' ? 2 : 7;
  const order = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];
  const placement = {};
  'abcdefgh'.split('').forEach((f, i) => {
    placement[f + back] = order[i];
    placement[f + pawns] = 'p';
  });
  return placement;
}

/** Two players in `room` (a fresh one by default), classic rules agreed, standard setups submitted -> playing. */
async function startClassicGame(srv, room) {
  const code = room || await newRoom(srv);
  const white = connect(srv, code);
  const wAssigned = await white.waitFor('assigned');
  const black = connect(srv, code);
  const bAssigned = await black.waitFor('assigned');

  const cfg = await white.waitFor('config');
  white.emit('agreeConfig', { version: cfg.version });
  black.emit('agreeConfig', { version: cfg.version });
  await white.waitFor('state', (s) => s.phase === 'setup');
  await black.waitFor('state', (s) => s.phase === 'setup');

  white.emit('submitArrangement', { placement: standardPlacement('w') });
  black.emit('submitArrangement', { placement: standardPlacement('b') });
  await white.waitFor('state', (s) => s.phase === 'playing');
  await black.waitFor('state', (s) => s.phase === 'playing');

  return { room: code, white, black, whiteToken: wAssigned.token, blackToken: bAssigned.token };
}

/** Make a move as `mover` and wait until `other` has seen it. */
async function play(mover, other, from, to) {
  const before = (other.lastState() || { moveLog: [] }).moveLog.length;
  mover.emit('makeMove', { from, to });
  await other.waitFor('state', (s) => s.moveLog.length === before + 1);
}

/** No square of `board` may expose a type/color of the opponent (fog invariant). */
function assertFogged(assert, board, viewerColor) {
  for (const [sq, cell] of Object.entries(board)) {
    if (!cell) continue;
    if (cell.occupied) {
      assert.deepEqual(Object.keys(cell), ['occupied'], `opponent square ${sq} leaks data`);
    } else {
      assert.equal(cell.color, viewerColor, `square ${sq} shows an opponent piece type`);
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = {
  startServer, newRoom, wsUrl, connect, upgradeStatus, startClassicGame,
  standardPlacement, play, assertFogged, sleep,
};
