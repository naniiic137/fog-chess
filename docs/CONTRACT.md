# Fog Chess - Socket.io Contract (v1)

**This is the binding interface between the backend and frontend build agents.**
Both build strictly to this file so they can work in parallel and interoperate on
the first try. If PLAN.md and this file disagree about a payload, **this file wins**.

Transport: Socket.io (default namespace `/`). The frontend loads the client from
the server-served path `/socket.io/socket.io.js`. All payloads are plain JSON
objects. All events use a single object argument (never positional args).

---

## 0. Shared conventions and types

### 0.1 Square coordinates
Algebraic strings, lowercase file + rank digit: `"a1"` .. `"h8"`. Files `a..h`
left-to-right, ranks `1..8` bottom (White) to top (Black). There are exactly 64.

### 0.2 Color and role
- `color`: `"w"` (White) or `"b"` (Black). Used everywhere in payloads.
- `role`: `"white"` or `"black"` (human-readable mirror; same meaning).

### 0.3 Piece type
Lowercase single letter: `"p"` pawn, `"r"` rook, `"n"` knight, `"b"` bishop,
`"q"` queen, `"k"` king.

### 0.4 Piece object
`{ "type": "q", "color": "w" }`  (type is a piece-type letter; color is `"w"|"b"`).

### 0.5 Filtered board cell (what a client sees for one square)
Exactly one of:
- Own piece:       `{ "type": "n", "color": "w" }`
- Opponent piece:  `{ "occupied": true }`         (no type, no color, EVER)
- Empty:           `null`

### 0.6 Filtered board object
A JSON object keyed by ALL 64 square strings, each value a filtered board cell:
```json
{
  "a1": { "type": "r", "color": "w" },
  "b1": { "type": "n", "color": "w" },
  "e8": { "occupied": true },
  "d4": null,
  "...": "... all 64 keys always present ..."
}
```
Rule: for a given viewer, own pieces -> `{type,color}`; opponent pieces ->
`{occupied:true}`; empty -> `null`. The server MUST emit a distinct filtered
board to each color. The raw/full board is NEVER emitted except inside
`gameOver.fullBoard`.

### 0.7 Full (revealed) board object
Same 64-key shape but every occupied square is a full piece object
`{type,color}` and empty squares are `null`. Used ONLY in `gameOver`.

### 0.8 Arrangement placement object
`{ [square]: pieceType }`, exactly 16 entries, squares on the submitter home
ranks only (White: ranks 1-2; Black: ranks 7-8). pieceType is a lowercase letter.
Color is implied by the submitter and is NOT included here.
```json
{ "placement": { "e1":"k","d1":"q","a1":"r","h1":"r","b1":"n","g1":"n",
                 "c1":"b","f1":"b","a2":"p","b2":"p","c2":"p","d2":"p",
                 "e2":"p","f2":"p","g2":"p","h2":"p" } }
```

### 0.9 Move log entry (per-viewer, already filtered by server)
Own move (full detail):
```json
{ "ply": 1, "color": "w", "from": "e2", "to": "e4", "piece": "p",
  "san": "e4", "capture": false, "capturedType": null,
  "promotion": null, "own": true, "text": "Pawn e2->e4" }
```
Opponent move (anonymized - never includes `piece` or `san`):
```json
{ "ply": 2, "color": "b", "from": "e7", "to": "e5", "capture": false,
  "capturedType": null, "own": false, "text": "unknown piece: e7->e5" }
```
When a capture is revealed (`revealCapturedPieceType:true`), `capturedType` is set
on both own and opponent entries, and `text` gets a suffix like
`" (captured Knight)"`.

### 0.10 Move destination (in legalMoves)
`{ "to": "e4", "promotion": false }`  (`promotion:true` means choosing this
destination requires a promotion piece; there is exactly ONE entry per target
square even though multiple promotion pieces are possible).

---

## 1. Connection / role assignment

### `assigned`  (server -> client)
Sent immediately after a socket connects and is granted a slot.
```json
{ "color": "w", "role": "white" }
```

### `rejected`  (server -> client)
Sent when both slots are already taken (3rd+ connection). The client shows a
"match full" message and does nothing else.
```json
{ "reason": "full" }
```

### `waiting`  (server -> client)
Sent to a connected player while the opponent slot is still empty.
```json
{ "message": "Waiting for opponent to connect" }
```

Note: a full `state` event (Section 6) is also sent and is authoritative for the
UI phase. `assigned`/`waiting` are convenience signals; clients MUST rely on
`state.phase` + `state.yourColor` for rendering decisions.

---

## 2. Setup phase

### `submitArrangement`  (client -> server)
Player locks in their secret arrangement (this doubles as the "Ready" action).
```json
{ "placement": { "e1":"k","d1":"q", "...": "16 entries total" } }
```
Server validates (counts, home ranks, valid squares). Then:
- On success: sets that player `ready=true`, emits `arrangementAccepted` to the
  sender, and a fresh `state` to both. When BOTH are ready, transitions to
  `playing` (see `gameStart`).
- On failure: emits `arrangementRejected` to the sender only; no state change.

### `arrangementAccepted`  (server -> client)
```json
{ "ok": true }
```

### `arrangementRejected`  (server -> client)
```json
{ "reason": "Must place exactly 16 pieces on your home ranks" }
```

### `gameStart`  (server -> client, both)
Emitted once, when both arrangements are in and the board is built. A full
`playing` `state` (Section 6) is emitted immediately after.
```json
{ "turn": "w" }
```

---

## 3. Requesting legal moves

### `requestMoves`  (client -> server)
Player selected one of their OWN pieces.
```json
{ "square": "e2" }
```

### `legalMoves`  (server -> client, requester only)
Private response. Empty `moves` if it is not the requester turn, the square is
empty, or the square holds an opponent piece.
```json
{ "square": "e2",
  "moves": [ { "to": "e3", "promotion": false },
             { "to": "e4", "promotion": false } ],
  "hasMoves": true }
```

---

## 4. Making a move

### `makeMove`  (client -> server)
```json
{ "from": "e2", "to": "e4", "promotion": null }
```
`promotion` is `"q"|"r"|"b"|"n"` when the move is a pawn reaching the last rank,
otherwise `null`/omitted. If a promotion is required but omitted, the server
defaults to `"q"`.

Server behavior:
- Validates turn + ownership + legality via chess.js. If illegal, emits
  `errorMsg` to the sender only and makes no state change.
- If legal: applies the move, appends to the move log, flips the turn, runs
  end-of-game detection, then emits (in this order):
  1. `moveMade` to EACH color (its own filtered log entry) - for animation + log.
  2. `capture` to both (only if a capture occurred and reveal is on).
  3. `check` to the player now in check (only if someone is in check).
  4. `state` to EACH color (authoritative post-move snapshot).
  5. `gameOver` to both (only if the game ended).

### `moveMade`  (server -> client, per-viewer)
The `entry` is already filtered for the recipient (own = full, opponent =
anonymized), matching Section 0.9. Included so the client can animate from->to
and append to its log without waiting to diff `state`.
```json
{ "entry": { "ply": 3, "color": "w", "from": "g1", "to": "f3",
             "piece": "n", "san": "Nf3", "capture": false,
             "capturedType": null, "promotion": null, "own": true,
             "text": "Knight g1->f3" },
  "from": "g1", "to": "f3" }
```
The top-level `from`/`to` are always present (even for opponent moves) so the
recipient can render the transition; `entry` carries the (possibly anonymized)
log line.

### `errorMsg`  (server -> client, sender only)
```json
{ "message": "Illegal move" }
```

---

## 5. Check and capture notifications

### `check`  (server -> client, checked player only)
Reveals the checking piece SQUARE, never its identity.
```json
{ "inCheck": true, "checkSquare": "h5" }
```
(The non-checked player is NOT sent this event; their `state.inCheck` is false.)

### `capture`  (server -> client, both)
Sent when a capture occurs and `revealCapturedPieceType` is true (default).
Reveals only the captured (removed) piece type/color; the capturing piece stays
hidden unless it is the recipient own piece (as reflected in `state`/`moveMade`).
```json
{ "square": "e5", "capturedType": "p", "capturedColor": "b" }
```

---

## 6. Authoritative per-viewer state broadcast

### `state`  (server -> client, per-viewer)
The single source of truth for what a client renders. Emitted after every
state change (connect, arrangement accepted, move, game over, rematch reset).
Each color receives its OWN payload with its OWN filtered board, filtered move
log, and its OWN check info.
```json
{
  "phase": "playing",
  "yourColor": "w",
  "yourRole": "white",
  "turn": "w",
  "yourTurn": true,
  "opponentConnected": true,
  "yourReady": true,
  "opponentReady": true,
  "inCheck": false,
  "checkSquare": null,
  "board": { "a1": {"type":"r","color":"w"}, "e8": {"occupied":true},
             "d4": null, "...": "all 64 keys" },
  "moveLog": [
    { "ply":1, "color":"w", "from":"e2","to":"e4","piece":"p","san":"e4",
      "capture":false,"capturedType":null,"promotion":null,"own":true,
      "text":"Pawn e2->e4" },
    { "ply":2, "color":"b", "from":"e7","to":"e5","capture":false,
      "capturedType":null,"own":false,"text":"unknown piece: e7->e5" }
  ],
  "result": null
}
```
Field meaning by phase:
- `lobby`: `board` is an all-`null` 64-key object; `opponentConnected` false.
- `setup`: `board` all-`null`; `yourReady`/`opponentReady` reflect submissions.
  (Setup rendering of the player own tray/ranks is purely client-side; the
  server does not echo the in-progress placement.)
- `playing`: `board` is the filtered live board; `turn`/`yourTurn`/`inCheck`/
  `checkSquare` are live.
- `ended`: `result` is set (see 0.9-style result below); use `gameOver` for the
  full reveal. `board` remains the viewer filtered board.

`result` when set:
```json
{ "result": "checkmate", "winner": "w", "reason": "checkmate" }
```
`result` values: `"checkmate" | "stalemate" | "draw" | "resign" | "opponentLeft"`.
`winner`: `"w" | "b" | null` (null for stalemate/draw).

---

## 7. Game over / reveal

### `gameOver`  (server -> client, both)
Reveals BOTH full boards. This is the ONLY event carrying full opponent info.
```json
{
  "result": "checkmate",
  "winner": "w",
  "reason": "checkmate",
  "fullBoard": { "a1": {"type":"r","color":"w"},
                 "e8": {"type":"k","color":"b"},
                 "d4": null, "...": "all 64 keys, both colors visible" },
  "fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1"
}
```
A `state` with `phase:"ended"` is also emitted. Clients render the reveal from
`gameOver.fullBoard`.

---

## 8. Resign

### `resign`  (client -> server)
No payload required (send `{}`). The sender forfeits.
```json
{}
```
Server sets `result` = `{result:"resign", winner:<other color>, reason:"resign"}`,
transitions to `ended`, and emits `gameOver` (full reveal) + `state` to both.

---

## 9. Rematch

### `rematch`  (client -> server)
Request to play again. Both players must request before the reset happens.
```json
{}
```
Server behavior:
- Marks the sender rematch=true. If only one has requested, emits
  `rematchPending { by: "w" }` to both (so the UI can show "opponent wants a
  rematch" / "waiting for opponent").
- When BOTH have requested: clears arrangements, ready, rematch, move log, board,
  and result; sets `phase:"setup"`; emits a fresh `setup` `state` to both. Colors
  are retained (White stays White, Black stays Black).

### `rematchPending`  (server -> client, both)
```json
{ "by": "w" }
```

---

## 10. Event summary table

Client -> Server:
| Event              | Payload                                  |
|--------------------|------------------------------------------|
| `submitArrangement`| `{ placement: {square:pieceType x16} }`  |
| `requestMoves`     | `{ square }`                             |
| `makeMove`         | `{ from, to, promotion? }`               |
| `resign`           | `{}`                                     |
| `rematch`          | `{}`                                     |

Server -> Client:
| Event                 | Direction        | Payload summary                              |
|-----------------------|------------------|----------------------------------------------|
| `assigned`            | to socket        | `{ color, role }`                            |
| `rejected`            | to socket        | `{ reason }`                                 |
| `waiting`             | to socket        | `{ message }`                                |
| `arrangementAccepted` | to sender        | `{ ok }`                                     |
| `arrangementRejected` | to sender        | `{ reason }`                                 |
| `gameStart`           | both             | `{ turn }`                                   |
| `legalMoves`          | to requester     | `{ square, moves[], hasMoves }`             |
| `moveMade`            | per-viewer       | `{ entry, from, to }`                        |
| `errorMsg`            | to sender        | `{ message }`                                |
| `check`               | to checked player| `{ inCheck, checkSquare }`                  |
| `capture`             | both             | `{ square, capturedType, capturedColor }`   |
| `state`               | per-viewer       | full snapshot (Section 6)                    |
| `gameOver`            | both             | `{ result, winner, reason, fullBoard, fen }` |
| `rematchPending`      | both             | `{ by }`                                     |

---

## 11. Invariants both builders MUST uphold

1. A `state.board` or `moveMade.entry` sent to a viewer NEVER contains an opponent
   piece `type` (except a revealed `capturedType`). Only `gameOver.fullBoard`
   reveals opponent types.
2. Every board object always has all 64 square keys present.
3. All colors are `"w"|"b"`; all piece types are lowercase letters; all squares
   are algebraic `"a1".."h8"`.
4. The server emits per-viewer payloads for `state`, `moveMade`, and `check`
   (never a single shared board to both).
5. Pins are entirely client-side and appear in NO event in this contract.
6. Castling never appears: no castling destination in `legalMoves`, FEN castling
   field is always `-`.
