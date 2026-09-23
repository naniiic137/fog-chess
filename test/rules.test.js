'use strict';

// Game-level rule tests (no sockets): castling from the standard setup, the new
// Chaos draw rules, and the plain-English move log.

const test = require('node:test');
const assert = require('node:assert/strict');
const FogChessGame = require('../src/game');
const { buildFen, castlingRights } = require('../src/fen');
const { standardPlacement } = require('./helpers');

function seatBoth(game) {
  game.connect('W', {});
  game.connect('B', {});
  game.maybeStartConfig();
}

function classicGame() {
  const game = new FogChessGame();
  seatBoth(game);
  assert.ok(game.agreeConfig('w', game.configVersion).ok);
  assert.ok(game.agreeConfig('b', game.configVersion).started);
  assert.ok(game.submitArrangement('w', standardPlacement('w')).ok);
  assert.ok(game.submitArrangement('b', standardPlacement('b')).started);
  return game;
}

function chaosGame(roster, white, black) {
  const game = new FogChessGame();
  seatBoth(game);
  game.proposeConfig('w', { mode: 'chaos', boardDims: { cols: 8, rows: 8 }, roster, bannedTypes: [], enabledFairy: [] });
  game.agreeConfig('w', game.configVersion);
  assert.ok(game.agreeConfig('b', game.configVersion).started);
  assert.ok(game.submitArrangement('w', white).ok);
  assert.ok(game.submitArrangement('b', black).started);
  return game;
}

test('castling rights follow the king and rook squares', () => {
  assert.equal(castlingRights(standardPlacement('w'), standardPlacement('b')), 'KQkq');
  const w = standardPlacement('w');
  w.a1 = 'n'; w.b1 = 'r'; // queenside rook moved off its corner
  assert.equal(castlingRights(w, standardPlacement('b')), 'Kkq');
  const b = standardPlacement('b');
  b.e8 = 'q'; b.d8 = 'k'; // king not on e8: no black castling at all
  assert.equal(castlingRights(standardPlacement('w'), b), 'KQ');
  assert.match(buildFen(standardPlacement('w'), standardPlacement('b')), / w KQkq - 0 1$/);
});

test('standard setup can castle kingside, logged in plain words', () => {
  const game = classicGame();
  for (const [c, from, to] of [
    ['w', 'g1', 'f3'], ['b', 'g8', 'f6'], ['w', 'g2', 'g3'],
    ['b', 'g7', 'g6'], ['w', 'f1', 'g2'], ['b', 'f8', 'g7'],
  ]) {
    assert.ok(game.makeMove(c, from, to).ok, `${from}-${to}`);
  }
  const legal = game.getLegalMoves('w', 'e1').moves.map((m) => m.to);
  assert.ok(legal.includes('g1'), 'O-O offered');
  const res = game.makeMove('w', 'e1', 'g1');
  assert.ok(res.ok);
  assert.equal(res.record.castle, 'k');
  assert.deepEqual(game.chess.get('f1'), { type: 'r', color: 'w' });

  const own = game.buildState('w').moveLog[6];
  assert.equal(own.text, 'Castles kingside (e1→g1)');
  const opp = game.buildState('b').moveLog[6];
  assert.equal(opp.text, 'Hidden piece e1→g1');
  assert.equal(opp.castle, undefined, 'castling stays hidden from the opponent');
});

test('capture wording is natural for both sides', () => {
  const game = classicGame();
  game.makeMove('w', 'e2', 'e4');
  game.makeMove('b', 'd7', 'd5');
  game.makeMove('w', 'e4', 'd5');
  assert.equal(game.buildState('w').moveLog[2].text, 'Pawn e4→d5, takes Pawn');
  assert.equal(game.buildState('b').moveLog[2].text, 'Hidden piece e4→d5, takes your Pawn');
});

test('chaos: threefold repetition is a draw', () => {
  const game = chaosGame({ k: 1, n: 1 }, { a1: 'k', b1: 'n' }, { a8: 'k', b8: 'n' });
  const cycle = [['w', 'b1', 'c3'], ['b', 'b8', 'c6'], ['w', 'c3', 'b1'], ['b', 'c6', 'b8']];
  let last;
  for (let i = 0; i < 2; i++) {
    for (const [c, from, to] of cycle) {
      assert.equal(game.phase, 'playing');
      last = game.makeMove(c, from, to);
      assert.ok(last.ok);
    }
  }
  assert.equal(last.ended, true);
  assert.equal(game.phase, 'ended');
  assert.deepEqual(game.result, { result: 'draw', winner: null, reason: 'threefold' });
});

test('chaos: 50 moves each without a capture or pawn move is a draw', () => {
  const game = chaosGame({ k: 1, n: 1 }, { a1: 'k', b1: 'n' }, { a8: 'k', b8: 'n' });
  game.halfmoveClock = 98;
  assert.ok(game.makeMove('w', 'b1', 'c3').ok);
  assert.equal(game.phase, 'playing');
  const res = game.makeMove('b', 'b8', 'c6');
  assert.equal(res.ended, true);
  assert.equal(game.result.reason, 'moveLimit');
});

test('chaos: a pawn move resets the move-limit counter', () => {
  const game = chaosGame({ k: 1, p: 1 }, { a1: 'k', e2: 'p' }, { a8: 'k', e7: 'p' });
  game.halfmoveClock = 98;
  assert.ok(game.makeMove('w', 'e2', 'e3').ok);
  assert.equal(game.halfmoveClock, 0);
  assert.equal(game.phase, 'playing');
});
