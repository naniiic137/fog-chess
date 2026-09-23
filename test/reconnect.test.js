'use strict';

// Reconnection, abandonment timeout and the end-state reveal, exercised through
// real socket.io clients against an in-process server.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, connect, startClassicGame, play, sleep } = require('./helpers');

const GRACE_MS = 400;

/** No square of `board` may expose a type/color of `oppColor` (fog invariant). */
function assertFogged(board, viewerColor) {
  for (const [sq, cell] of Object.entries(board)) {
    if (!cell) continue;
    if (cell.occupied) {
      assert.deepEqual(Object.keys(cell), ['occupied'], `opponent square ${sq} leaks data`);
    } else {
      assert.equal(cell.color, viewerColor, `square ${sq} shows an opponent piece type`);
    }
  }
}

function countTypes(board, color) {
  return Object.values(board).filter((c) => c && c.type && c.color === color).length;
}

test('reload mid-game: seat is held, opponent is told, fogged view is restored', async (t) => {
  const srv = await startServer({ reconnectGraceMs: GRACE_MS * 5 });
  t.after(() => srv.close());
  const { white, black, whiteToken } = await startClassicGame(srv.url);
  await play(white, black, 'e2', 'e4');

  white.close();
  const away = await black.waitFor('state', (s) => s.opponentConnected === false);
  assert.equal(away.phase, 'playing', 'a disconnect must not end the game');
  assert.ok(away.opponentAwayMs > 0 && away.opponentAwayMs <= GRACE_MS * 5);
  assert.equal(away.result, null);

  // A stranger cannot take the reserved seat meanwhile.
  const stranger = connect(srv.url);
  const rej = await stranger.waitFor('rejected');
  assert.equal(rej.reason, 'reconnecting');
  stranger.close();

  // White comes back with its token.
  const white2 = connect(srv.url, { token: whiteToken });
  const assigned = await white2.waitFor('assigned');
  assert.equal(assigned.color, 'w');
  assert.equal(assigned.resumed, true);
  assert.equal(assigned.token, whiteToken);

  const st = await white2.waitFor('state', (s) => s.phase === 'playing');
  assert.equal(st.yourColor, 'w');
  assert.deepEqual(st.board.e4, { type: 'p', color: 'w' });
  assert.equal(st.board.e2, null);
  assert.deepEqual(st.board.e8, { occupied: true });
  assertFogged(st.board, 'w');
  assert.equal(st.moveLog.length, 1);
  assert.deepEqual(st.lastMove, { from: 'e2', to: 'e4' });
  assert.equal(st.opponentConnected, true);
  assert.equal(st.gameOver, undefined, 'no reveal while the game is running');

  await black.waitFor('state', (s) => s.opponentConnected === true && s.opponentAwayMs === null);

  // The game simply continues.
  await play(black, white2, 'e7', 'e5');
  await play(white2, black, 'g1', 'f3');
  const after = await white2.waitFor('state', (s) => s.moveLog.length === 3);
  assert.equal(after.moveLog[1].own, false);
  assert.equal(after.moveLog[1].piece, undefined, 'opponent move stays anonymous');
  assert.match(after.moveLog[1].text, /^Hidden piece e7→e5$/);

  white2.close();
  black.close();
});

test('a player who stays away past the window loses by abandonment, with full reveal', async (t) => {
  const srv = await startServer({ reconnectGraceMs: GRACE_MS });
  t.after(() => srv.close());
  const { white, black, whiteToken } = await startClassicGame(srv.url);
  await play(white, black, 'd2', 'd4');

  white.close();
  await black.waitFor('state', (s) => s.opponentConnected === false && s.phase === 'playing');

  const over = await black.waitFor('gameOver', null, GRACE_MS * 5);
  assert.equal(over.result, 'abandoned');
  assert.equal(over.winner, 'b');
  assert.equal(countTypes(over.fullBoard, 'w'), 16, 'white army revealed');
  assert.equal(countTypes(over.fullBoard, 'b'), 16, 'black army revealed');
  assert.deepEqual(over.fullBoard.d4, { type: 'p', color: 'w' });

  const ended = await black.waitFor('state', (s) => s.phase === 'ended');
  assert.equal(ended.result.winner, 'b');
  assert.equal(countTypes(ended.gameOver.fullBoard, 'w'), 16);

  // Coming back after the window: the old token no longer owns a seat, so this
  // is a newcomer, who gets a fresh match rather than the old end screen.
  const late = connect(srv.url, { token: whiteToken });
  const assigned = await late.waitFor('assigned');
  assert.equal(assigned.resumed, false);
  assert.notEqual(assigned.token, whiteToken);
  const fresh = await late.waitFor('state');
  assert.equal(fresh.phase, 'config');
  assert.equal(fresh.result, null);
  assert.equal(fresh.moveLog.length, 0);
  await black.waitFor('state', (s) => s.phase === 'config');

  late.close();
  black.close();
});

test('game over survives a reload: ended state carries the full reveal and named log', async (t) => {
  const srv = await startServer({ reconnectGraceMs: GRACE_MS * 5 });
  t.after(() => srv.close());
  const { white, black, whiteToken } = await startClassicGame(srv.url);
  await play(white, black, 'e2', 'e4');
  await play(black, white, 'd7', 'd5');
  await play(white, black, 'e4', 'd5');

  black.socket.emit('resign');
  const over = await white.waitFor('gameOver');
  assert.equal(over.result, 'resign');
  assert.equal(over.winner, 'w');
  assert.ok(over.fen, 'classic game over includes the final FEN');

  white.close();
  await black.waitFor('state', (s) => s.phase === 'ended' && s.opponentConnected === false);

  const white2 = connect(srv.url, { token: whiteToken });
  const assigned = await white2.waitFor('assigned');
  assert.equal(assigned.resumed, true);
  const st = await white2.waitFor('state', (s) => s.phase === 'ended');
  assert.equal(st.result.winner, 'w');
  assert.equal(st.result.reason, 'resign');
  assert.ok(st.gameOver, 'ended state carries the gameOver payload');
  assert.equal(countTypes(st.gameOver.fullBoard, 'b'), 15, 'black pieces revealed after reload');
  assert.deepEqual(st.gameOver.fullBoard.d8, { type: 'q', color: 'b' });

  // After the game, the log names the opponent's pieces too.
  assert.equal(st.moveLog.length, 3);
  const blackMove = st.moveLog[1];
  assert.equal(blackMove.piece, 'p');
  assert.equal(blackMove.revealed, true);
  assert.equal(blackMove.text, 'Pawn d7→d5');
  assert.equal(st.moveLog[2].text, 'Pawn e4→d5, takes Pawn');
  for (const e of st.moveLog) assert.doesNotMatch(e.text, /Hidden|unknown/);

  white2.close();
  black.close();
});

test('same tab reconnecting before the old socket dropped takes the seat over', async (t) => {
  const srv = await startServer({ reconnectGraceMs: GRACE_MS * 5 });
  t.after(() => srv.close());
  const { white, black, whiteToken } = await startClassicGame(srv.url);

  // Without the takeover flag a live seat is not stolen (e.g. a copied token).
  const copy = connect(srv.url, { token: whiteToken });
  assert.equal((await copy.waitFor('rejected')).reason, 'full');
  copy.close();

  const again = connect(srv.url, { token: whiteToken, takeover: true });
  const assigned = await again.waitFor('assigned');
  assert.equal(assigned.color, 'w');
  assert.equal(assigned.resumed, true);
  assert.equal((await white.waitFor('rejected')).reason, 'replaced');

  await play(again, black, 'c2', 'c4');
  const st = black.lastState();
  assert.equal(st.opponentConnected, true);
  assert.equal(st.phase, 'playing');

  again.close();
  black.close();
  white.close();
});

test('both players gone past the window resets to an empty lobby', async (t) => {
  const srv = await startServer({ reconnectGraceMs: GRACE_MS });
  t.after(() => srv.close());
  const { white, black } = await startClassicGame(srv.url);
  white.close();
  black.close();
  await sleep(GRACE_MS * 3);
  assert.equal(srv.game.phase, 'lobby');
  assert.deepEqual(srv.game.tokens, { white: null, black: null });

  const next = connect(srv.url);
  const a = await next.waitFor('assigned');
  assert.equal(a.color, 'w');
  const st = await next.waitFor('state');
  assert.equal(st.phase, 'lobby');
  next.close();
});
