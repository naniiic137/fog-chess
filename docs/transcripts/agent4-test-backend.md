# Agent 4 — Backend Test Transcript (TEST AGENT A)

Role: Backend correctness + chess-rules fidelity + **fog-leak audit** for "Fog Chess".
Method: drove the REAL running server (`PORT=3100 node server.js`) with scripted
`socket.io-client` clients (CommonJS). No app source files were modified; only
scratchpad test scripts were created. Server was restarted between games because
the single-match server has no fresh-lobby path once a match ends (and because the
rematch reset path crashes — see BUG-1).

Environment: Node v22.14.0, chess.js 1.4.0, socket.io 4.8.1 (server), socket.io-client 4.x
(installed into the scratchpad, project `package.json`/`node_modules` untouched).

## Overall verdict: **FAIL** (one CRITICAL functional bug) — but the **FOG-LEAK AUDIT PASSED**.

The fog never leaked opponent piece types in any tested payload. The single failure
is a server-crashing bug in the **rematch** path (not a fog leak, not a rules break).

---

## Scripts written (scratchpad)
- `lib.js` — `Client` wrapper (records every server event with a global sequence
  counter), `startGame(wPlace,bPlace)`, `move(mover,other,from,to,promo)` (clears
  logs, emits, returns per-client ordered event names), `auditFilteredBoard` /
  `auditClientLog` (the core fog invariant scanner), standard placements.
- `test1_conn_setup.js` — Scenario 1 (roles/waiting/rejected) + Scenario 2 (arrangement validation + non-standard accept).
- `test2_moves.js` — Scenarios 3,4,5,6 (moves, legal moves, illegal, capture, check, emit order, fog) + 8 (resign) + 10 (rematch).
- `test3_promo.js` — Scenario 7 (promotion) + Scenario 8 (back-rank pawn).
- `test4_mate.js` — Scenario 9 (checkmate, Scholar's mate).
- `test5_fogstress.js` — Scenario 3 adversarial: ground-truth board diff + deep recursive payload scan.
- `test6_stalemate.js` — Scenario 9 (stalemate, Sam Loyd 10-move line).
- `test7_disconnect.js` — end condition: disconnect → `opponentLeft`.

Core fog scanner rule (viewer-only, needs no ground truth): for every cell in every
`state.board` (and recursively every non-`gameOver` payload), any cell carrying a
`type` MUST have `color === viewerColor`; any `{occupied:true}` cell must carry NO
`type`/`color` and no extra keys. Plus a ground-truth diff comparing each viewer's
board against a local chess.js instance loaded from the same FEN.

---

## Results per scenario

### Scenario 1 — Connection / roles — PASS (test1: 13/13 of the conn checks)
- 1st client → `assigned {color:"w",role:"white"}` + `waiting` + a `lobby` `state` (`opponentConnected:false`).
- 2nd client → `assigned {color:"b",role:"black"}`, **no** `waiting`; both transition to `setup` `state` (`opponentConnected:true`), board all-64 null.
- 3rd client → `rejected {reason:"full"}`, receives no `assigned` and no `state`.

### Scenario 2 — Arrangement validation — PASS (all)
Rejected (with sender-only `arrangementRejected`, no state change) for:
- 15 pieces and 17-effective (count) → "Must place exactly 16 pieces…"
- wrong composition (queen replaced by pawn) → "Wrong piece composition…"
- off home-rank (h3) → "Square h3 is not on your home ranks"
- white placing on opponent rank (h7) → "Square h7 is not on your home ranks"
- invalid square string (z9) → "Invalid square: z9"
- invalid piece type (x) → "Invalid piece type: x"
Accepted a **non-standard** arrangement: king on **c1** (not e-file) AND **pawns on the
back rank a1/h1** → `arrangementAccepted {ok:true}`, `yourReady:true`, still `setup`
until Black ready. Both ready → `gameStart {turn:"w"}` to both, then `playing` `state`
(White `yourTurn:true`, Black `yourTurn:false`). White sees own back-rank pawn a1 as
`{type:"p",color:"w"}`, Black's e8 as `{occupied:true}`; 16 own + 16 occupied cells.

### Scenario 3 — FOG LEAK AUDIT (highest priority) — **PASS (no leaks anywhere)**
- `auditClientLog` run over BOTH viewers' full event streams in test1, test2, test3,
  test4, test6: **0 leaks** in every game.
- `test5_fogstress.js`: a 16-ply capture-heavy melee. After each ply, each viewer's
  `state.board` was diffed against a local chess.js ground truth: **32 board
  comparisons, 0 leaks/mismatches** — every opponent-occupied square was exactly
  `{occupied:true}` (never a `type`, and never wrongly shown as empty), every own
  square matched truth, every empty square was `null`.
- Deep **recursive** scan of every non-`gameOver` payload object (state, moveMade,
  legalMoves, check, capture, gameStart, rematchPending): **0** opponent-colored
  piece objects reached a viewer.
- `moveMade` opponent entries never carry `piece`/`san` (checked in every game);
  opponent log text is `"unknown piece: <from>-><to>"`.
- Opponent identity stays hidden even where a square is highlighted: `checkSquare`
  (b5, f7) and freshly-captured/promoted squares (d5, g8) all render `{occupied:true}`
  to the opponent.
- The only opponent types ever observed were the allowed `capturedType` (in
  `capture`/log) and `gameOver.fullBoard`.

### Scenario 4 — Legal moves + moving — PASS
- `requestMoves` own pawn e2 → `{moves:[{e3,false},{e4,false}], hasMoves:true}`.
- `requestMoves` opponent piece, not-your-turn, empty square → `{moves:[],hasMoves:false}`.
- Illegal move (e2→e5) → `errorMsg {message:"Illegal move"}` to sender; **no** `state`,
  **no** `moveMade`, turn unchanged.
- Legal e2→e4 → `moveMade` to both; turn flips to `b`; White own entry full
  (`piece:"p",san:"e4",own:true`); Black entry anonymized (`own:false`, no piece/san,
  top-level `from`/`to` present).
- Emit ORDER (CONTRACT §4) verified via a global sequence counter:
  - non-capture non-check move → `[moveMade, state]`
  - capture move → `[moveMade, capture, state]`
  - check move → `[moveMade, check, state]` (to checked viewer)
  - checkmate move → `[moveMade, capture, state, gameOver]`
  - stalemate move → `[moveMade, state, gameOver]`

### Scenario 5 — Capture reveal — PASS
White e4xd5 → `capture {square:"d5",capturedType:"p",capturedColor:"b"}` to **both**;
capturedType appears in both logs (own text "…(captured Pawn)", opponent text
anonymized but with capturedType); the capturing White pawn on d5 is still
`{occupied:true}` to Black (capturing piece stays hidden).

### Scenario 6 — Check — PASS
White Bf1-b5+ → `check {inCheck:true, checkSquare:"b5"}` to Black only; White gets NO
`check` event and White `state.inCheck:false`. Black `state.inCheck:true,
checkSquare:"b5"`. `checkSquare` b5 cross-checked against the mover's known full
position (it holds the checking bishop) and is shown to Black as `{occupied:true}`
(identity withheld). Also verified on the checkmate move: `checkSquare:"f7"` to the
mated side only.

### Scenario 7 — Promotion — PASS
Marched a White g-pawn to h7 (capturing to h5) then h7xg8:
- `legalMoves` for h7 → `{to:"g8", promotion:true}` (single collapsed entry per target).
- `makeMove h7→g8` with `promotion` **omitted (null)** → server defaulted to `q`:
  record `promotion:"q"`, `san:"hxg8=Q"`. Promoted piece is White queen on g8 to the
  mover; `{occupied:true}` to the opponent. Capture-promotion revealed the captured
  knight (`capturedType:"n"`).

### Scenario 8 — Back-rank pawn behavior — PASS (accepted, no crash, no double-step)
- Back-rank pawns accepted in setup (a1/h1 in test1; a1 in test3); engine loaded via
  `skipValidation` and did not crash.
- A pawn on a1 with a2 blocked → `hasMoves:false`. After freeing a2 (moved the a2
  knight), `requestMoves a1` → **only** `[{to:"a2",promotion:false}]` — single step,
  **no double-step** (a3 absent). Matches PLAN §6.3 (accepted behavior, not a bug).

### Scenario 9 — End conditions — PASS
- **Resign**: Black resigns → `gameOver {result:"resign",winner:"w",reason:"resign",
  fullBoard(64 keys, both colors),fen}` to both; `state.phase:"ended"`,
  `state.result:{resign,w,resign}`.
- **Checkmate** (Scholar's mate Qxf7#): `gameOver {result:"checkmate",winner:"w"}`;
  capture of f7 revealed; mated Black got `check checkSquare:"f7"`, White did not;
  fullBoard reveals both kings; `state.phase:"ended"`.
- **Stalemate** (Sam Loyd 10-move line): final Qe6 → `gameOver
  {result:"stalemate",winner:null,reason:"stalemate"}`; no `check` on the final move;
  `state.phase:"ended"`, `state.result.winner:null`. Emit order `[moveMade,state,gameOver]`.
- **Disconnect** (bonus end condition): mid-game disconnect → remaining player gets
  `gameOver {result:"opponentLeft",winner:"w",reason:"opponentLeft"}` + ended `state`
  with `opponentConnected:false`.

### Scenario 10 — Rematch — **FAIL (CRITICAL: server crash)** — see BUG-1
`W` emits `rematch {}` → expected `rematchPending {by:"w"}` to both; instead **NO event
arrived and the server process crashed** with an uncaught `TypeError`. All 7 rematch
assertions failed as a consequence. Rematch is completely non-functional.

### Scenario 11 — Contract conformance — PASS
All observed payloads matched CONTRACT shapes: boards always 64 keys; colors `"w"/"b"`;
piece types lowercase; squares algebraic; per-viewer `state`/`moveMade`/`check`;
`legalMoves` `{square,moves[],hasMoves}`; `capture {square,capturedType,capturedColor}`;
`gameOver {result,winner,reason,fullBoard,fen}`; FEN castling field always `-`
(e.g. `rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b - - 0 1`); no castling in any
`legalMoves`. `result` object shape `{result,winner,reason}` matches §6.

---

## BUGS

### BUG-1 (CRITICAL, functional — NOT a fog leak): `rematch` crashes the entire server
- **What I did**: after a game ended (resign), White emitted `rematch {}`.
- **Expected**: `rematchPending {by:"w"}` to both; on the second request, reset to a
  fresh `setup` state (colors retained), per CONTRACT §9.
- **Actual**: no events; the Node server process died. Server stderr:
  ```
  server.js:169  const res = game.rematch(color);
  TypeError: game.rematch is not a function
  ```
- **Root cause**: name collision in `src/game.js`. The state field
  `this.rematch = { white:false, black:false }` (set in `reset()` / `resetForRematch()`)
  is an **own instance property that shadows the prototype method `rematch(color)`**.
  Confirmed directly: `typeof game.rematch === "object"` (the flags object), while
  `typeof FogChessGame.prototype.rematch === "function"`. So `server.js:169`
  `game.rematch(color)` invokes a non-function and throws. Because the throw is inside
  the socket handler with no try/catch, the whole process exits — killing the live
  match for BOTH players, not just the rematch.
- **Impact**: rematch (CONTRACT §9) is 100% broken, and any single rematch click takes
  down the server. High blast radius.
- **Suggested fix** (`src/game.js`): rename the method or the field so they don't
  collide. Cleanest: rename the method `rematch(color)` → e.g. `requestRematch(color)`
  and update the one call site `server.js:169`. (Alternatively rename the field, e.g.
  `this.rematchRequests`, and update its internal uses in `rematch()`,
  `resetForRematch()`, `reset()`, and `handleDisconnect()`.) The `ready`/`result`/
  `turn`/`phase`/`chess` fields don't collide with any method — only `rematch` does.

No other bugs found. No fog leak found. No chess-rules break found.

---

## Commands run (representative)
- `cd scratchpad && npm init -y && npm install socket.io-client@4`  (scratchpad only)
- `PORT=3100 node server.js`  (background; restarted between games)
- `node test1_conn_setup.js` → 33/33 PASS
- `node test2_moves.js` → 39/46 (7 fails = BUG-1 rematch crash; server exited code 1)
- `node test3_promo.js` → 13/13 PASS
- `node test4_mate.js` → 15/15 PASS
- `node test5_fogstress.js` → 2/2 PASS (32 ground-truth comparisons, deep scan clean)
- `node test6_stalemate.js` → 7/7 PASS
- `node test7_disconnect.js` → 4/4 PASS

## Cleanup
Server stopped (`Stop-Process node`); 0 node processes remain; port 3100 only shows
harmless TIME_WAIT sockets. No project source files were modified; all test artifacts
live only in the scratchpad.
