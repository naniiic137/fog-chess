'use strict';

// Shared helpers for the socket-level tests: spin up an isolated server on a
// random port, connect socket.io clients that record every event, and drive a
// classic game up to the playing phase.

const { io: ioClient } = require('socket.io-client');
const { createServer } = require('../server');

async function startServer(options) {
  const instance = createServer(options);
  const port = await instance.listen(0);
  return { ...instance, url: `http://127.0.0.1:${port}` };
}

/**
 * connect(url, auth) -> client. `client.waitFor(event, pred)` resolves with the
 * first not-yet-consumed payload of `event` matching `pred`, whether it already
 * arrived or arrives later.
 */
function connect(url, auth) {
  const socket = ioClient(url, {
    auth: auth || {},
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });
  const client = { socket, log: [] };
  socket.onAny((event, payload) => {
    client.log.push({ event, payload, used: false });
  });

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
        socket.offAny(handler);
        reject(new Error(`timed out waiting for "${event}"`));
      }, ms || 3000);
      function handler(ev, payload) {
        if (ev !== event || !test(payload)) return;
        clearTimeout(timer);
        socket.offAny(handler);
        const entry = client.log.find((e) => e.payload === payload && e.event === ev);
        if (entry) entry.used = true;
        resolve(payload);
      }
      socket.onAny(handler);
    });
  };

  /** Latest `state` received so far (or null). */
  client.lastState = () => {
    for (let i = client.log.length - 1; i >= 0; i--) {
      if (client.log[i].event === 'state') return client.log[i].payload;
    }
    return null;
  };

  client.close = () => socket.disconnect();
  return client;
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

/** Two players, classic rules agreed, standard setups submitted -> playing. */
async function startClassicGame(url) {
  const white = connect(url);
  const wAssigned = await white.waitFor('assigned');
  const black = connect(url);
  const bAssigned = await black.waitFor('assigned');

  const cfg = await white.waitFor('config');
  white.socket.emit('agreeConfig', { version: cfg.version });
  black.socket.emit('agreeConfig', { version: cfg.version });
  await white.waitFor('state', (s) => s.phase === 'setup');
  await black.waitFor('state', (s) => s.phase === 'setup');

  white.socket.emit('submitArrangement', { placement: standardPlacement('w') });
  black.socket.emit('submitArrangement', { placement: standardPlacement('b') });
  await white.waitFor('state', (s) => s.phase === 'playing');
  await black.waitFor('state', (s) => s.phase === 'playing');

  return { white, black, whiteToken: wAssigned.token, blackToken: bAssigned.token };
}

/** Make a move as `mover` and wait until `other` has seen it. */
async function play(mover, other, from, to) {
  const before = (other.lastState() || { moveLog: [] }).moveLog.length;
  mover.socket.emit('makeMove', { from, to });
  await other.waitFor('state', (s) => s.moveLog.length === before + 1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { startServer, connect, startClassicGame, standardPlacement, play, sleep };
