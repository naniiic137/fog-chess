# Fog Chess - Implementation Plan (v1)

Authoritative implementation plan for a two-player, real-time LAN chess variant.
This document plus `CONTRACT.md` are the shared source of truth for the backend
and frontend build agents. Where this plan and `CONTRACT.md` disagree about a
Socket.io payload, **`CONTRACT.md` wins**.

---

## 1. Core principle (do not violate)

The chess rules engine is **completely standard, full-information, server-only**.
Fog-of-war is a **per-viewer view filter applied at emit time only**. The raw
board (real opponent piece types) is NEVER sent to a client. All hidden-info
logic lives in exactly one module (`src/fog.js`). If fog logic starts leaking
into move generation or validation, that is a bug.

Locked decisions baked into this plan:

- `chess.js` (`^1.4.0`) is the rules engine, server-side only.
- **No castling in v1.** No castling moves are ever generated or accepted. The
  FEN castling field is always `-`. We do NOT implement Chess960 castling.
- **Pawns have full placement freedom**, including their own back rank (rank 1
  for White, rank 8 for Black). FENs are loaded with `load(fen, { skipValidation: true })`.
- `revealCapturedPieceType: true` (default): a captured piece type is shown to
  both players once off the board; the capturing piece stays hidden unless it is
  the viewer own piece.
- Check (default): the checked player is told they are in check and the checking
  piece **square** is highlighted; its identity is withheld.
- In-memory state, one match, no DB, no accounts, no HTTPS, no build step.

Out of scope (do not build): reconnect handling, multiple rooms, spectators,
clocks, animation polish, mobile gestures, internet deploy.

---

## 2. File / folder structure and ownership

```
hidden chess/
  package.json            [BACKEND]  deps + "start" script
  server.js               [BACKEND]  Express static server + Socket.io wiring + LAN URL print
  src/
    game.js               [BACKEND]  GameState: phase machine, players, arrangements, moves, log
    fen.js                [BACKEND]  arrangement -> FEN string + arrangement validation
    fog.js                [BACKEND]  per-viewer filtered board + filtered move log + full-reveal board
  public/
    index.html            [FRONTEND] all screens (lobby / setup / game / end) as show/hide sections
    style.css             [FRONTEND] board grid, tray, pins, banners
    client.js             [FRONTEND] socket handling, rendering, drag setup, legal-move UI, pins
  PLAN.md                 (this file)
  CONTRACT.md             (socket contract - shared)
  transcripts/
    agent1-planner.md     (planner transcript)
```

### File ownership split (STRICT - prevents collisions)

- **BACKEND builder owns:** `package.json`, `server.js`, and everything under
  `src/` (`src/game.js`, `src/fen.js`, `src/fog.js`).
- **FRONTEND builder owns:** everything under `public/`
  (`public/index.html`, `public/style.css`, `public/client.js`).
- Neither builder edits the other files. Neither edits `PLAN.md`,
  `CONTRACT.md`, or `transcripts/`.
- The only coupling between the two is `CONTRACT.md`. Both build strictly to it.

The frontend loads the Socket.io client from the server-served path
`/socket.io/socket.io.js` (Socket.io serves this automatically). No CDN, no
bundler, no build step.

---

## 3. Game state model (server, in memory)

A single module-level `GameState` object (only one match in v1):

```
GameState = {
  phase: "lobby" | "setup" | "playing" | "ended",
  players: {
    white: socketId | null,
    black: socketId | null
  },
  chess: <chess.js instance | null>,     // full truth, server-only, never emitted raw
  arrangements: {
    white: { [square]: pieceType } | null, // e.g. { "e1":"k", "a2":"p", ... }
    black: { [square]: pieceType } | null
  },
  ready: { white: false, black: false },
  rematch: { white: false, black: false },
  moveLog: [ MoveRecord, ... ],          // full-info records; filtered per viewer at emit
  turn: "w" | "b",                        // mirrors chess.turn() during playing
  result: null | { result, winner, reason }
}
```

Notes:
- **Pins are NOT in server state.** Pins are 100% client-side (Section 8).
- `arrangements` hold `pieceType` as a lowercase letter (`p r n b q k`); color is
  implied by which side submitted it. Color is applied when building the FEN.
- `MoveRecord` (full-info, server-only):
  `{ ply, color:"w"|"b", from, to, piece:"p".."k", san, capture:bool, capturedType:"p".."k"|null, promotion:"q"|"r"|"b"|"n"|null }`.
  `fog.js` converts this to the per-viewer log entry defined in `CONTRACT.md`.

---

## 4. Phase state machine

```
        both sockets connected
 lobby ------------------------------> setup
   ^                                      |
   |                                      | both submitArrangement (valid) => ready.white && ready.black
   |                                      v
   |                                   playing
   |                                      |
   |                                      | checkmate / stalemate / draw / resign
   |                                      v
   +----------- (never) ---------       ended
                                          |
                        both rematch=true | => reset arrangements/ready/log
                                          v
                                        setup
```

Transition rules:
- **lobby -> setup:** fires when `players.white` and `players.black` are both
  non-null. Server emits `phase:"setup"` state to both.
- **setup -> playing:** fires when both `ready.*` are true. Server builds the FEN
  from both arrangements (Section 6), constructs the `chess.js` instance with
  `skipValidation`, sets `turn="w"`, emits `gameStart` then a `playing` state.
- **playing -> ended:** fires on `chess.isCheckmate()` / `isStalemate()` /
  `isDraw()` after a move, or on `resign`. Server sets `result`, emits `gameOver`
  with the fully revealed board, then an `ended` state.
- **ended -> setup:** fires when both `rematch.*` are true. Server clears
  `arrangements`, `ready`, `rematch`, `moveLog`, `chess`, `result`, sets
  `phase:"setup"`, emits a fresh `setup` state. Colors are retained (White stays
  White).
- A 3rd+ connection while both slots are full is rejected (`rejected {reason:"full"}`).

---

## 5. The fog filter (`src/fog.js`)

Pure functions, no side effects. Square convention: algebraic `"a1".."h8"`.

### 5.1 filterBoard(chess, viewerColor)
Returns a **map of all 64 squares** -> value:
- viewer own piece:       `{ type: "q", color: "w" }`
- opponent piece:         `{ occupied: true }`   (NO type, NO color)
- empty square:           `null`

Implementation: iterate `chess.board()` (8x8, rank 8 -> rank 1), or iterate the
64 square names calling `chess.get(sq)`. For each real piece, if
`piece.color === viewerColor` emit `{type,color}` else emit `{occupied:true}`.

### 5.2 revealBoard(chess)
Full board for game end / reveal: map of all 64 squares ->
`{ type, color } | null`. Both colors fully visible. Used ONLY in `gameOver`.

### 5.3 filterMoveRecord(record, viewerColor)
Converts a full `MoveRecord` to the per-viewer log entry:
- If `record.color === viewerColor` (viewer own move): include full detail
  (`from`, `to`, `piece`, `san`, `capture`, `capturedType`, `promotion`, `text`).
- Else (opponent move): anonymize -> only `{ ply, color, from, to, capture,
  capturedType (only if revealCapturedPieceType), text }`. NEVER include the
  moving `piece` or `san` for an opponent move. `text` reads
  `"unknown piece: e7->e5"` (append `" (captured Knight)"` when a capture is
  revealed).

### 5.4 checkInfoFor(chess, viewerColor)
Returns `{ inCheck: bool, checkSquare: string|null }` for the viewer:
- `inCheck` is true only if it is the viewer who is in check
  (`chess.turn() === viewerColor && chess.isCheck()`).
- `checkSquare` = the square of an attacking (checking) piece, found via
  `chess.attackers(kingSquare, opponentColor)` (chess.js `attackers` returns the
  squares attacking a given square). Return the first attacker square. Identity
  is never included - only the square. If not in check, both fields are null/false.

**Never emit anything from `fog.js` that carries an opponent piece type**
(except a revealed captured type when `revealCapturedPieceType` is true).

---

## 6. Custom arrangement -> FEN (`src/fen.js`)

### 6.1 Arrangement validation (`validateArrangement(placement, color)`)
`placement` is `{ [square]: pieceType }`, pieceType in `p r n b q k` (lowercase).
Reject (return an error reason string) unless ALL hold:
- Exactly 16 entries.
- Piece-type multiset is exactly: 8 `p`, 2 `r`, 2 `n`, 2 `b`, 1 `q`, 1 `k`.
- Every square is on the player two home ranks:
  White -> ranks `1` and `2`; Black -> ranks `7` and `8`.
- No duplicate squares (guaranteed by object keys, but also reject unknown/bad
  square strings not matching `^[a-h][1-8]$`).
Valid pawns on the back rank (rank 1 White / rank 8 Black) are ALLOWED.

### 6.2 Build FEN (`buildFen(whitePlacement, blackPlacement)`)
Produce a standard FEN string:
1. **Piece placement**, rank 8 down to rank 1, each rank file a -> h:
   - White pieces are UPPERCASE (`PRNBQK`), Black lowercase (`prnbqk`).
   - White pieces come from `whitePlacement` (ranks 1-2 only); Black from
     `blackPlacement` (ranks 7-8 only). Ranks 3-6 are entirely empty.
   - Consecutive empty squares are collapsed into a digit count (e.g. `8` for a
     full empty rank, `3p4` etc). Ranks are joined with `/`.
2. **Side to move:** `w`.
3. **Castling availability:** `-` (ALWAYS - castling dropped in v1).
4. **En passant target:** `-`.
5. **Halfmove clock:** `0`. **Fullmove number:** `1`.

Example (standard start rank arrangement, just for shape):
`rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1`

Load with: `chess.load(fen, { skipValidation: true })`.

### 6.3 Back-rank pawn edge case (MUST document in code + UI)
- chess.js `skipValidation:true` accepts pawns on rank 1/8. This is required.
- A pawn placed on its own back rank cannot double-step: chess.js only grants the
  two-square move from rank 2 (White) / rank 7 (Black). A back-rank pawn simply
  advances one square at a time until it reaches rank 2/7, from where it moves
  normally. This is ACCEPTED v1 behavior - not a bug. Do not try to "fix" it.
- Promotion still works normally (a White pawn reaching rank 8 / Black rank 1
  promotes as usual).
- A pawn is never auto-placed on the opponent back rank during setup because
  setup is constrained to the player own two home ranks.

---

## 7. Legal-move highlighting (`src/game.js`)

- Client selects one of its OWN pieces and emits `requestMoves { square }`.
- Server rejects if not that player turn, or the square does not hold a piece
  of the requesting player color (respond with empty `moves`).
- Otherwise call `chess.moves({ square, verbose: true })` and map to
  `[{ to, promotion:bool }]`. `promotion` is true for any move whose verbose
  `flags` include `p` (a pawn reaching the last rank). De-duplicate promotion
  targets (chess.js returns one verbose move per promotion piece; collapse them
  to a single `{to, promotion:true}` entry).
- Respond `legalMoves { square, moves, hasMoves }`. This is a private response to
  the requesting socket only - it reveals only the viewer own mobility, which
  is allowed.
- Castling moves never appear (no castling rights in the FEN).

Making a move: client emits `makeMove { from, to, promotion? }`.
- Server validates it is the mover turn and the from-square holds their piece.
- Server calls `chess.move({ from, to, promotion })`. If the move is a pawn
  reaching the last rank and `promotion` is omitted, default to `"q"`.
- If `chess.move` returns null (illegal), respond `errorMsg { message }` and do
  NOT change state.
- On success: append a full `MoveRecord` to `moveLog`, flip `turn`, run end-of-game
  detection, then broadcast per-viewer `state` + emit `moveMade` (per-viewer,
  filtered) + `check`/`capture`/`gameOver` as applicable (see `CONTRACT.md`).

---

## 8. Pins (client-side ONLY - `public/client.js`)

Pins are never sent to the server and never touch `GameState`.
- Structure in the client: `pins[square] = { guess, note }` where `guess` is one
  of `Pawn|Knight|Bishop|Rook|Queen|King` or free text.
- Interaction: click an occupied OPPONENT square (a `{occupied:true}` cell) ->
  open a small picker -> store the pin -> render a small overlay icon/letter on
  that square, visible only in this client.
- Auto-fade: after each `state` update, for every pinned square, if that square is
  no longer `{occupied:true}` in the new filtered board (it became `null` or
  is now the viewer own piece), fade/clear that pin. The player may manually
  re-pin elsewhere.
- Persistence: in-memory for the session is sufficient; optional `localStorage`.
  Cleared on rematch/new setup.
- Because pins are purely local, the two build agents need no coordination on
  them beyond "the frontend owns this entirely."

---

## 9. Server wiring (`server.js`)

- Express serves `public/` statically. Socket.io attaches to the same HTTP server.
- On `connection`:
  - If `players.white` is empty -> assign White. Else if `players.black` is empty
    -> assign Black. Else emit `rejected {reason:"full"}` and return.
  - Emit `assigned { color, role }` to the socket.
  - If both slots now filled and phase was `lobby`, transition to `setup` and
    broadcast `state` to both; otherwise emit a `waiting` state to the new socket.
- Register handlers: `submitArrangement`, `requestMoves`, `makeMove`, `resign`,
  `rematch` (all defined in `CONTRACT.md`). Each handler mutates `GameState` via
  `game.js` then emits per-viewer payloads.
- On `disconnect`: v1 does not handle reconnect. Minimal behavior: free that
  color slot and, if a match was in progress, emit an `opponentLeft` gameOver-style
  state so the remaining client is not stuck. Keep minimal; reconnect is out of scope.
- **LAN URL print:** on `listen`, enumerate `os.networkInterfaces()`, pick the
  first non-internal IPv4 address, and print `http://<ip>:<port>` to the console
  so a second device can connect. Also print `http://localhost:<port>`.

### Per-viewer broadcast helper
A single function `broadcastState()` computes and emits the `state` payload
separately to White and Black (each with its own filtered board, filtered log,
and its own check info). Every state-changing handler ends by calling it. This is
the ONLY place raw board data becomes viewer-specific payloads, alongside the
one-off `gameOver` reveal.

---

## 10. Frontend structure (`public/`)

- `index.html`: four `<section>` screens toggled by a `data-phase` attribute on
  `<body>`: `#lobby` (waiting), `#setup` (own two ranks + tray + Ready),
  `#game` (8x8 board + turn indicator + check banner + move log + Resign),
  `#end` (revealed board + result + Rematch). One 8x8 board component reused via
  CSS grid (or `<table>`).
- `client.js` responsibilities:
  - Connect to `/socket.io/socket.io.js`; handle `assigned`, `state`,
    `legalMoves`, `moveMade`, `check`, `capture`, `gameOver`, `rejected`,
    `errorMsg`, `waiting` (all per `CONTRACT.md`).
  - Setup phase: render the player own home ranks + a tray of 16 pieces;
    drag/drop to place; validate counts locally for UX; emit `submitArrangement`
    on Ready.
  - Game phase: render the filtered board. Own pieces show real icons; opponent
    `{occupied:true}` squares render a neutral `?` marker; `null` squares empty.
    Clicking an own piece emits `requestMoves` and highlights returned
    destinations; clicking a highlighted square emits `makeMove`. Show the
    from->to transition on incoming `moveMade`. Render the move log (already
    anonymized by the server). Show a check banner + highlight `checkSquare`.
  - Pins layer (Section 8), entirely local.
  - End phase: render the revealed full board from `gameOver`; show Rematch.
- Rendering rule: the client renders EXACTLY what the server sends. It must never
  try to infer opponent piece types. If a cell is `{occupied:true}`, it is a `?`.

---

## 11. Build order (recommended)

Both builders can start immediately against `CONTRACT.md`. Suggested sequence:

1. **Backend skeleton:** `package.json` (express, socket.io, chess.js), `server.js`
   with static serving + LAN URL print + connection/role assignment + `waiting`.
2. **Frontend skeleton:** `index.html` + `style.css` + `client.js` that connects,
   shows the waiting screen, and logs every received event. Verify two browser
   tabs get White/Black + `waiting`.
3. **Setup phase:** `fen.js` (validate + buildFen) backend; setup UI + drag/tray +
   `submitArrangement` frontend. Verify both-ready -> `gameStart`.
4. **Playing core:** `game.js` move handling + `fog.js` filterBoard/filterMoveRecord;
   frontend board render + `requestMoves`/`makeMove`. Verify a full legal game with
   fog applied (opponent pieces are `?`).
5. **Notifications:** `check` (with square), `capture` reveal, anonymized move log.
6. **End + rematch:** `gameOver` full reveal, `resign`, `rematch` reset to setup.
7. **Pins:** frontend-only pin layer + auto-fade.
8. **Polish pass:** turn indicator, error toasts, back-rank pawn note in UI.

---

## 12. Risks / notes handed to builders and testers

- **Never emit the raw board.** The only full-info emit is `gameOver.fullBoard`.
  Testers: confirm no `state.board` cell ever carries an opponent `type`.
- **`attackers` availability:** relies on chess.js `attackers(square, color)`
  (present in 1.4.0). If a different chess.js version lacks it, fall back to
  scanning opponent pieces verbose moves for one that targets the king square.
- **Back-rank pawns** get no double-step and that is intended (Section 6.3).
- **Promotion:** client must send `promotion` for last-rank pawn moves; server
  defaults to `q` if missing. Frontend should offer a promotion picker.
- **Per-viewer emits:** state/moveMade/check must be emitted to each color
  separately with its own filtered payload - do not `io.emit` a single shared
  board.
- **Disconnect** is intentionally minimal (out of scope); do not over-build it.
- **Contract precedence:** if PLAN and CONTRACT differ on a payload, CONTRACT wins.

### Critical Files for Implementation
- C:\Users\Naniii\Documents\Github\hidden chess\CONTRACT.md
- C:\Users\Naniii\Documents\Github\hidden chess\src\game.js
- C:\Users\Naniii\Documents\Github\hidden chess\src\fog.js
- C:\Users\Naniii\Documents\Github\hidden chess\src\fen.js
- C:\Users\Naniii\Documents\Github\hidden chess\public\client.js
