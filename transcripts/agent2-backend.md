# Agent 2 - Backend Builder Transcript

Role: BACKEND BUILDER for "Fog Chess". Implemented the complete Node.js backend
strictly against `CONTRACT.md` (binding) and `PLAN.md`. Owns `package.json`,
`server.js`, and everything under `src/`. Did not touch anything under `public/`.

## Files created and their responsibilities

### `package.json`
- CommonJS (`"type": "commonjs"`) — `require` throughout, simplest per the brief.
- Script `"start": "node server.js"`.
- Dependencies pinned: `chess.js ^1.4.0`, `express ^4.21.2`, `socket.io ^4.8.1`.

### `src/fen.js` — arrangement validation + FEN construction
- `validateArrangement(placement, color)` returns an error reason string or
  `null`. Enforces: exactly 16 entries; every square matches `^[a-h][1-8]$`;
  every square on the submitter home ranks (White 1-2, Black 7-8); no duplicate
  squares; and the piece multiset is EXACTLY 8p/2r/2n/2b/1q/1k. Back-rank pawns
  (rank 1 White / rank 8 Black) are allowed.
- `buildFen(whitePlacement, blackPlacement)` composes the two arrangements into a
  standard FEN: piece placement rank 8→1 / file a→h, White UPPERCASE + Black
  lowercase, ranks 3–6 empty, empties collapsed to digits, then always
  ` w - - 0 1` (side `w`, castling ALWAYS `-`, en passant `-`, halfmove 0,
  fullmove 1). A code comment documents the back-rank-pawn no-double-step caveat.

### `src/fog.js` — THE fog filter (only place hidden-info logic lives)
- `ALL_SQUARES` (64 names), `emptyBoard()` (all-null 64-key object).
- `filterBoard(chess, viewerColor)` — CONTRACT 0.6: own piece `{type,color}`,
  opponent piece `{occupied:true}` (never type/color), empty `null`. 64 keys.
- `revealBoard(chess)` — CONTRACT 0.7 full reveal; used ONLY for
  `gameOver.fullBoard`.
- `filterMoveRecord(record, viewerColor, config)` — CONTRACT 0.9: own move full
  (includes `piece`, `san`, `text` like "Knight g1->f3"); opponent move
  anonymized (no `piece`, no `san`, `text` "unknown piece: e7->e5"). `capturedType`
  surfaced on both only when `config.revealCapturedPieceType` is true; capture
  suffix " (captured Knight)" appended to `text`.
- `checkInfoFor(chess, viewerColor)` — `inCheck` true only when it is the viewer
  to move AND `chess.isCheck()`; `checkSquare` is a checking piece square
  (identity withheld).
- `findAttackerSquare(chess, targetSq, byColor)` — prefers native
  `chess.attackers(square, color)`; if unavailable/throws, falls back to a
  version-agnostic geometry scan (knight offsets, pawn diagonals, sliding rays
  for bishop/rook/queen, king adjacency). Returns only a square.

### `src/game.js` — `FogChessGame` state machine
- Phase machine `lobby → setup → playing → ended` with in-memory state per
  PLAN section 3 (players, chess instance, arrangements, ready, rematch, moveLog,
  turn, result).
- `addPlayer` (1st→White, 2nd→Black, 3rd+→null), `colorOf`, `socketOf`,
  `maybeStartSetup`.
- `submitArrangement(color, placement)` validates via `fen.validateArrangement`,
  sets ready; when both ready calls `startPlaying()`.
- `startPlaying()` builds the FEN and loads with
  `chess.load(fen, { skipValidation: true })` (pawns may sit on rank 1/8).
- `getLegalMoves(color, square)` returns CONTRACT-3 shape; only when it is the
  requester turn and their own piece; promotion targets de-duplicated to one
  `{to, promotion:true}` per square using verbose `flags` containing `p`.
- `makeMove(color, from, to, promotion)` validates turn/ownership/legality via
  `chess.move` (wrapped in try/catch since 1.x throws on illegal), defaults
  promotion to `q` when a last-rank pawn move omits it, appends a full
  MoveRecord, flips turn, runs end detection (checkmate/stalemate/draw). Returns
  the record, a capture descriptor (with en-passant capture-square correction),
  and ended/result.
- `resign`, `rematch` (both-request reset to setup, colors retained),
  `resetForRematch`, and minimal `handleDisconnect` (frees slot; ends game with
  `opponentLeft` if playing; drops back to lobby if in setup).
- `buildState(viewerColor)` and `buildGameOver()` produce the per-viewer CONTRACT-6
  and CONTRACT-7 payloads using `fog.*`.

### `server.js` — Express + Socket.io wiring
- Serves `public/` statically; Socket.io serves its client at the default
  `/socket.io/socket.io.js`. Port 3000 with `PORT` env override.
- On `listen`, prints `Fog Chess running at:` then `http://localhost:<port>` plus
  every non-internal IPv4 from `os.networkInterfaces()` (handles both string
  `"IPv4"` and numeric `4` family values).
- On connection: assign slot → `assigned` (or `rejected {reason:"full"}` for 3rd+),
  `maybeStartSetup`, `waiting` if opponent absent, then per-viewer `state`.
- Handlers: `submitArrangement` (→ `arrangementAccepted`/`arrangementRejected`,
  `gameStart` to both on start, then `state`), `requestMoves` (→ `legalMoves` to
  requester), `makeMove` (emits in the EXACT CONTRACT-4 order: per-viewer
  `moveMade` → `capture` both → `check` to checked player only → per-viewer
  `state` → `gameOver` both if ended), `resign` (→ `gameOver` + `state`),
  `rematch` (→ `rematchPending` or reset+`state`), `disconnect`.
- Per-viewer emits use `socketFor(color)` so `state`/`moveMade`/`check` are each
  built and sent separately per color (never a single shared board). `emitToBoth`
  targets only the two player sockets, so a rejected 3rd socket receives nothing.
- `CONFIG = { revealCapturedPieceType: true }`.

## chess.js version pinned and why
`chess.js ^1.4.0` (installed exactly 1.4.0). 1.x is the current major line and
provides every API used: `load(fen,{skipValidation})`, `move`, `moves`, `get`,
`board`, `turn`, `fen`, `isCheck`, `isCheckmate`, `isStalemate`, `isDraw`, and
`attackers(square, color)`. Verified all exist in the installed build (see below).
A geometry fallback for the check square is included so the code is not fragile to
a version lacking `attackers`.

## How the FEN is built
`src/fen.js buildFen` maps each placement square to a FEN char (White uppercase,
Black lowercase), then walks ranks 8→1, files a→h, collapsing consecutive empties
to digits, joining ranks with `/`, and appending ` w - - 0 1`. Castling is always
`-`. It is loaded with `skipValidation:true` because pawns may legally be on the
back rank in this variant. Documented in code: a back-rank pawn cannot double-step
(chess.js only double-steps from rank 2/7) — accepted behavior.

## How the fog filter works
All board/log emits pass through `src/fog.js`. `filterBoard` shows the viewer own
pieces as `{type,color}`, every opponent piece as `{occupied:true}` (no type/color
ever), empty squares as `null`, for all 64 keys. `filterMoveRecord` anonymizes
opponent moves (drops `piece`/`san`, uses "unknown piece: from->to"). The only
full-info emit is `gameOver.fullBoard` via `revealBoard`.

## How the check square is found
`checkInfoFor` reports `inCheck` only for the side to move when `isCheck()` is
true, then locates the king and calls `findAttackerSquare`, which uses native
`chess.attackers(kingSquare, opponentColor)` and returns the first attacker
square. A geometry-scan fallback (knights, pawns, sliding rays, king adjacency)
covers any chess.js build lacking `attackers`. Only the square is exposed.

## Deviations from PLAN (CONTRACT still honored)
- `resign` emit order: CONTRACT section 8 prose says "gameOver + state"; I emit
  `gameOver` then `state` (matching that section). `makeMove` uses the explicit
  numbered CONTRACT-4 order (state before gameOver). Both match their own
  contract sections; the frontend handles game-over from either signal.
- Disconnect during `setup` drops the shared state back to `lobby` (clears
  ready/arrangements) so the remaining player is not stuck mid-setup with no
  opponent. PLAN only mandates freeing the slot + not crashing; this is a minimal,
  contract-neutral choice (no new events; uses `state`).
- Draw detection relies on chess.js `isDraw()` (covers threefold, 50-move,
  insufficient material) after checking checkmate then stalemate.
No payload shapes deviate from CONTRACT.

## Commands run and results
- `npm install` → "added 91 packages, and audited 92 packages in 15s … found 0
  vulnerabilities".
- API/FEN smoke test (node -e): `chess.js version: 1.4.0`; custom-arrangement FEN
  with a back-rank pawn loaded via `skipValidation` (`turn: w`); confirmed
  `attackers`, `isCheck`, `isCheckmate`, `isStalemate`, `isDraw` are functions.
- Fog/check test: for `4r3/8/8/8/8/8/8/4K3 w - - 0 1`, `attackers('e1','b')` =
  `["e8"]`; `checkInfoFor(w)` = `{inCheck:true, checkSquare:"e8"}`;
  `checkInfoFor(b)` = `{inCheck:false, checkSquare:null}`; white's filtered board
  shows `e8` as `{occupied:true}` and `e1` as `{type:"k",color:"w"}` with 64 keys.
- Server start (`node server.js`): printed
  `Fog Chess running at:` / `http://localhost:3000` /
  `http://192.168.1.216:3000` / `http://192.168.56.1:3000`. `GET
  /socket.io/socket.io.js` → HTTP 200 (Socket.io client served). Server stopped
  cleanly. (`GET /` currently has no `public/index.html` — the frontend agent owns
  that folder; it will serve once present.)

## Risks / notes for test agents
- No `public/` yet: `GET /` 404s / has nothing to serve until the frontend agent
  ships `index.html`. Socket.io transport works independently.
- Back-rank pawns get no double-step (intended, not a bug). A pawn fully blocked
  on its back rank has no moves until the square ahead clears.
- Single in-memory match; server holds no persistence. Restart clears everything.
- Disconnect handling is intentionally minimal (no reconnect). A mid-game
  disconnect ends the game with `result:"opponentLeft"` and frees the slot for a
  fresh connection.
- `resign` vs `makeMove` game-over emit ordering differs (see Deviations) — both
  follow their respective CONTRACT sections; test both paths.
- Invariant to verify: no `state.board` cell and no `moveMade.entry` ever carries
  an opponent `type` (only `capturedType` on captures and `gameOver.fullBoard`
  reveal do). All filtering is centralized in `src/fog.js`.
