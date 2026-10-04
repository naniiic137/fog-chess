'use strict';

// Rooms and the WebSocket protocol: room codes, independent matches, full rooms,
// bad room codes, and payloads a client should never be able to hurt us with.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  startServer, newRoom, wsUrl, connect, upgradeStatus, startClassicGame, play, assertFogged,
} = require('./helpers');
const { isRoomCode, newRoomCode, parseMessage } = require('../src/room');

test('room codes are short, unambiguous and validated', async (t) => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const code = newRoomCode();
    assert.ok(isRoomCode(code), code);
    assert.doesNotMatch(code, /[01ILO]/);
    seen.add(code);
  }
  assert.ok(seen.size > 495, 'codes are random');
  for (const bad of ['', 'abc234', 'ABC23', 'ABC2345', 'ABC10O', 'ABC 23', null, 123456, '../../x']) {
    assert.equal(isRoomCode(bad), false, String(bad));
  }

  const srv = await startServer();
  t.after(() => srv.close());
  const res = await fetch(`${srv.url}/api/rooms`, { method: 'POST' });
  assert.equal(res.status, 200);
  const { room } = await res.json();
  assert.ok(isRoomCode(room));
  assert.notEqual(await newRoom(srv), room);
});

test('two rooms run independent matches on one server', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const a = await startClassicGame(srv);
  const b = await startClassicGame(srv);
  assert.notEqual(a.room, b.room);
  assert.equal(srv.rooms.size, 2);

  await play(a.white, a.black, 'e2', 'e4');
  await play(a.black, a.white, 'e7', 'e5');
  await play(b.white, b.black, 'd2', 'd4');

  const sa = a.white.lastState();
  const sb = b.white.lastState();
  assert.equal(sa.moveLog.length, 2);
  assert.equal(sb.moveLog.length, 1);
  assert.deepEqual(sa.board.e4, { type: 'p', color: 'w' });
  assert.equal(sb.board.e4, null);
  assert.deepEqual(sb.board.d4, { type: 'p', color: 'w' });
  assert.equal(b.black.lastState().turn, 'b');

  // Room B never heard about room A's moves.
  assert.equal(b.white.log.filter((e) => e.event === 'moveMade').length, 1);

  // Resigning in A ends A only.
  a.black.emit('resign');
  await a.white.waitFor('gameOver');
  await play(b.black, b.white, 'd7', 'd5');
  assert.equal(b.white.lastState().phase, 'playing');

  // Rematch in the same room: both back to the house-rules screen, same colours.
  a.white.emit('rematch');
  await a.black.waitFor('rematchPending', (d) => d.by === 'w');
  a.black.emit('rematch');
  const again = await a.white.waitFor('state', (s) => s.phase === 'config');
  assert.equal(again.yourColor, 'w');
  assert.equal(again.moveLog.length, 0);
  assert.equal((await a.black.waitFor('state', (s) => s.phase === 'config')).yourColor, 'b');
  assert.equal(b.white.lastState().phase, 'playing', 'room B is unaffected');

  for (const c of [a.white, a.black, b.white, b.black]) c.close();
});

test('a third player is told the room is full, and the socket is closed', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const { room, white, black } = await startClassicGame(srv);

  const third = connect(srv, room);
  const rej = await third.waitFor('rejected');
  assert.equal(rej.reason, 'full');
  assert.equal(await third.closed, 4001, 'closed with the "do not reconnect" code');
  assert.equal(third.log.some((e) => e.event === 'state'), false, 'a rejected socket gets no game state');

  // The match itself is untouched.
  await play(white, black, 'e2', 'e4');
  white.close();
  black.close();
});

test('invalid room codes and other paths are refused at the upgrade', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  assert.equal(await upgradeStatus(wsUrl(srv, 'abc234')), 400);
  assert.equal(await upgradeStatus(wsUrl(srv, 'ABCDEFG')), 400);
  assert.equal(await upgradeStatus(wsUrl(srv, 'ABC10O')), 400);
  assert.equal(await upgradeStatus(`${srv.url.replace(/^http/, 'ws')}/ws`), 400);
  assert.equal(await upgradeStatus(`${srv.url.replace(/^http/, 'ws')}/other?room=ABCDEF`), 404);
  assert.equal(srv.rooms.size, 0, 'no room was created');
  assert.equal(await upgradeStatus(wsUrl(srv, 'ABCDEF')), 101);
});

test('bad payloads are ignored; the fogged view never leaks', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  assert.equal(parseMessage('not json'), null);
  assert.equal(parseMessage('[1,2]'), null);
  assert.equal(parseMessage('{"t":5}'), null);
  assert.deepEqual(parseMessage('{"t":"x","id":3}'), { t: 'x', d: null, id: 3 });

  const room = await newRoom(srv);
  // Events before `hello` are ignored (no seat, no state).
  const early = connect(srv, room, false);
  early.emit('makeMove', { from: 'e2', to: 'e4' });
  assert.deepEqual(await early.request('ping'), {}, 'acks work');
  assert.equal(early.log.length, 0);
  early.close();

  const { white, black } = await startClassicGame(srv, room);
  // Junk of every kind: none of it may crash the room or change the game.
  white.send('not json');
  white.send('{"t":"__proto__","d":{}}');
  white.emit('noSuchEvent', { x: 1 });
  white.emit('makeMove', null);
  white.emit('makeMove', { from: ['e2'], to: 'e4' });
  white.emit('makeMove', { from: 'e2', to: 'e4', promotion: { q: 1 } });
  white.emit('requestMoves', { square: 'constructor' });
  white.emit('proposeConfig', { config: { mode: 'chaos', roster: { constructor: 1 } } });
  white.emit('submitArrangement', { placement: { __proto__: { a1: 'k' } } });
  white.emit('agreeConfig', { version: '1' });
  const bad = await white.waitFor('errorMsg');
  assert.equal(bad.message, 'Illegal move');
  assert.deepEqual(await white.request('ping'), {}, 'room still answers');
  assert.equal(white.lastState().moveLog.length, 0);

  // Too large a message closes that socket only.
  const big = connect(srv, room, false);
  big.send(JSON.stringify({ t: 'hello', d: { pad: 'x'.repeat(20000) } }));
  assert.notEqual(await big.closed, 1000);

  // Real play still works, and every payload either player received is fogged.
  await play(white, black, 'e2', 'e4');
  await play(black, white, 'd7', 'd5');
  await play(white, black, 'e4', 'd5');
  for (const [client, color] of [[white, 'w'], [black, 'b']]) {
    for (const e of client.log) {
      if (e.event === 'state' && e.payload.phase === 'playing') assertFogged(assert, e.payload.board, color);
      if (e.event === 'moveMade' && !e.payload.entry.own) {
        assert.equal(e.payload.entry.piece, undefined, 'opponent move stays anonymous');
      }
    }
  }
  white.close();
  black.close();
});
