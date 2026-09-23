# Fog Chess - Socket.io Contract (v2)

**Authoritative v2 interface. EXTENDS `CONTRACT.md` (v1); every v1 event keeps
working unchanged.** Both build agents build strictly to this file. If `PLAN-v2.md`
and this file disagree about a payload, **this file wins**. Where this file is
silent, v1 `CONTRACT.md` still applies.

Transport unchanged (Socket.io, default namespace, single-object payloads).

---

## A. What v2 adds (summary)

1. A new `config` phase with events `proposeConfig`, `agreeConfig` (client->server)
   and `config` (server->client).
2. `mode`, `boardDims`, and config/roster fields added to `state` (additive).
3. Board objects generalized: keyed by ALL squares of the current board
   (`cols*rows` keys), not hard-coded 64. Classic = 8x8 = the v1 64 keys.
4. Fairy piece types (`a c h i m w`) as OWN types; opponent fairy pieces still
   `{occupied:true}`.
5. `gameOver.reason` may be `"kingCaptured"` (chaos); result string may be
   `"kingCaptured"`.
6. Shared reference data: the movement-descriptor format and the piece catalog.

Backward-compat rule: a classic game produces payloads identical to v1 EXCEPT for
additive fields (`mode:"classic"`, `boardDims:{cols:8,rows:8}`, and the config
phase preceding setup). Consumers must ignore unknown/extra fields.

---

## B. Shared reference data (both builders use verbatim)

### B.1 Board dimensions
`boardDims = { "cols": <int 8..10>, "rows": <int 8|10> }`. Supported at minimum:
`{8,8}`, `{10,8}`, `{10,10}`. Classic is always `{8,8}`.

### B.2 Square strings (generalized)
- File = one lowercase letter, `a` + colIndex (0-based): `a`..`j` for up to 10 cols.
- Rank = integer `1..rows`, decimal (may be two digits, e.g. `10`).
- Square = `<letter><rank>`: `a1`, `j8`, `a10`, `j10`.
- **Parse rule (MANDATORY):** `^([a-z])([0-9]{1,2})$` — leading letter = file,
  trailing digits = rank. Never index `sq[1]` for the rank (breaks on `a10`).
- Classic squares are exactly `a1`..`h8` (identical to v1).

### B.3 Movement descriptor
```json
{
  "leaps":  [[1,2],[2,1]],
  "slides": [[1,0],[0,1]],
  "royal":  false,
  "pawn":   false
}
```
- `dx` = file delta (+ toward `j`), `dy` = rank delta (+ toward higher rank).
- `leaps`: single jump to `(f+dx, r+dy)`; ignores intervening squares.
- `slides`: repeat `(f+k·dx, r+k·dy)` for k=1,2,... until off-board or blocked;
  may capture the first enemy then stop; cannot pass/land on a friendly. (A
  "rider"/Nightrider is a slide with a knight vector — no separate key.)
- `royal:true` marks king-like pieces (capturable; counted for king-capture).
- `pawn:true` marks the special-cased pawn (see B.5); pawns have no leaps/slides.

Shared vector sets:
```
ORTHO  = [[1,0],[-1,0],[0,1],[0,-1]]
DIAG   = [[1,1],[1,-1],[-1,1],[-1,-1]]
ALL8   = ORTHO + DIAG
KNIGHT = [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]]
CAMEL  = [[1,3],[3,1],[3,-1],[1,-3],[-1,-3],[-3,-1],[-3,1],[-1,3]]
```

### B.4 Piece catalog  (letter -> {name, descriptor, royal})
```json
{
  "p": { "name": "Pawn",       "pawn": true,  "royal": false, "class": "standard" },
  "n": { "name": "Knight",     "leaps": "KNIGHT",                "royal": false, "class": "standard" },
  "b": { "name": "Bishop",     "slides": "DIAG",                 "royal": false, "class": "standard" },
  "r": { "name": "Rook",       "slides": "ORTHO",                "royal": false, "class": "standard" },
  "q": { "name": "Queen",      "slides": "ALL8",                 "royal": false, "class": "standard" },
  "k": { "name": "King",       "leaps": "ALL8",                  "royal": true,  "class": "standard" },
  "a": { "name": "Amazon",     "slides": "ALL8",  "leaps": "KNIGHT", "royal": false, "class": "fairy" },
  "c": { "name": "Chancellor", "slides": "ORTHO", "leaps": "KNIGHT", "royal": false, "class": "fairy" },
  "h": { "name": "Archbishop", "slides": "DIAG",  "leaps": "KNIGHT", "royal": false, "class": "fairy" },
  "i": { "name": "Nightrider", "slides": "KNIGHT",               "royal": false, "class": "fairy" },
  "m": { "name": "Camel",      "leaps": "CAMEL",                 "royal": false, "class": "fairy" },
  "w": { "name": "Wizard",     "leaps": "CAMEL+DIAG",            "royal": false, "class": "fairy" }
}
```
(The string tokens `KNIGHT`/`DIAG`/`ALL8`/`ORTHO`/`CAMEL`/`CAMEL+DIAG` expand to
the B.3 vector sets. Backend stores the expanded arrays; the tokens are shorthand
for this document. Frontend needs only `name` + `class` + letter for
rendering/badges.)

Badge letters for OWN fairy pieces (frontend): `A C H I M W` (uppercased type
letter). Standard pieces keep unicode glyphs. Opponent pieces of ANY class render
the neutral hidden token — never a badge or glyph.

### B.5 Chaos pawn rules (reference)
- White `dy=+1`, Black `dy=-1`. Forward 1 if empty.
- Double-step only from the color's SECOND rank (White rank `2`, Black rank
  `rows-1`), both squares empty. No en passant.
- Diagonal capture `(f±1, r+dy)` only onto an enemy piece.
- Promotion on reaching the far rank (White `rows`, Black `1`). Promotion options =
  roster types excluding royals (kings) and `p`; default `q` if present else first
  available; if none, pawn stays.

### B.6 Config object
```json
{
  "mode": "chaos",
  "boardDims": { "cols": 10, "rows": 10 },
  "bannedTypes": ["b"],
  "roster": { "k": 2, "q": 2, "r": 2, "n": 2, "p": 10, "a": 1, "i": 1 },
  "enabledFairy": ["a", "i"]
}
```
- Classic config is forced to:
  `{ "mode":"classic", "boardDims":{"cols":8,"rows":8},
     "bannedTypes":[], "roster":{"p":8,"r":2,"n":2,"b":2,"q":1,"k":1},
     "enabledFairy":[] }`.
- Validity constraints: `roster.k >= 1`; every roster type is a catalog letter and
  not in `bannedTypes`; fairy roster types must be in `enabledFairy`; board is a
  supported dim; and home regions fit: with `total = sum(roster)` and
  `N = max(2, ceil(total/cols))`, require `2*N <= rows`.

### B.7 Filtered / full board (generalized)
Same cell shapes as v1 (`{type,color}` | `{occupied:true}` | `null`) but the object
is keyed by ALL `cols*rows` squares of the current board. `type` may now be a fairy
letter for OWN pieces. Opponent pieces are ALWAYS `{occupied:true}` regardless of
class. Full board (`gameOver.fullBoard` only) shows every occupied square as
`{type,color}`.

### B.8 Arrangement placement (generalized)
`{ [square]: pieceType }`, one entry per roster piece, squares within the
submitter's home region only. Multiset MUST equal the agreed `roster`. Classic is
the v1 special case (16 entries, ranks 1-2/7-8, standard composition).

---

## C. Config phase events

### `proposeConfig`  (client -> server)
Either player proposes/edits the shared config. Replaces the shared config,
increments `version`, and RESETS both agreements.
```json
{ "config": {
    "mode": "chaos",
    "boardDims": { "cols": 10, "rows": 8 },
    "bannedTypes": [],
    "roster": { "k": 1, "q": 1, "r": 2, "n": 2, "b": 2, "p": 8, "a": 1 },
    "enabledFairy": ["a"]
} }
```
Server sanitizes (classic mode is forced to the classic preset), stores it,
`version++`, sets `agreed={white:false,black:false}`, and broadcasts `config`.

### `agreeConfig`  (client -> server)
Sender agrees to the CURRENT proposal. Must carry the version it is agreeing to.
```json
{ "version": 7 }
```
- If `version !== <current server version>`: IGNORED (stale; server re-broadcasts
  `config` so the client resyncs).
- Else: set `agreed[senderSide]=true`. If both agreed AND config is valid ->
  transition to `setup`, broadcast fresh `state` (phase `setup`). If both agreed
  but INVALID -> stay in `config`, reset `agreed`, broadcast `config` with
  `valid:false` + `error`.

### `config`  (server -> client, both)
Broadcast after every config change / agree.
```json
{
  "config": {
    "mode": "chaos",
    "boardDims": { "cols": 10, "rows": 8 },
    "bannedTypes": [],
    "roster": { "k": 1, "q": 1, "r": 2, "n": 2, "b": 2, "p": 8, "a": 1 },
    "enabledFairy": ["a"]
  },
  "agreed": { "white": true, "black": false },
  "version": 7,
  "valid": true,
  "error": null
}
```
`error` is a human-readable string when `valid:false` (e.g. `"Roster too large for
a 8-tall board (needs 6 home ranks per side)."` or `"At least one king is
required."`).

---

## D. Changed / extended existing events

### `state`  (server -> client, per-viewer) — ADDITIVE fields
All v1 fields remain. New/again-relevant fields:
```json
{
  "phase": "config",
  "yourColor": "w",
  "yourRole": "white",
  "mode": "chaos",
  "boardDims": { "cols": 10, "rows": 10 },

  "config": {
    "mode": "chaos",
    "boardDims": { "cols": 10, "rows": 10 },
    "bannedTypes": [],
    "roster": { "k": 2, "q": 1, "r": 2, "n": 2, "b": 2, "p": 12, "a": 1 },
    "enabledFairy": ["a"]
  },
  "agreed": { "white": false, "black": false },
  "configVersion": 3,

  "turn": "w",
  "yourTurn": false,
  "opponentConnected": true,
  "yourReady": false,
  "opponentReady": false,
  "inCheck": false,
  "checkSquare": null,
  "board": { "a1": null, "...": "all cols*rows keys" },
  "moveLog": [],
  "result": null
}
```
Field notes by phase:
- `lobby`: as v1; `board` is an all-`null` object keyed by the current
  `boardDims` (classic default `8x8` until a config is agreed). `mode` defaults to
  `"classic"`.
- `config` (NEW): `config` / `agreed` / `configVersion` are present and live.
  `board` is all-`null` for `boardDims`.
- `setup`: adds a `setup` block so the client can build the roster tray and home
  region:
  ```json
  "setup": {
    "roster": { "k": 2, "q": 1, "r": 2, "n": 2, "b": 2, "p": 12, "a": 1 },
    "boardDims": { "cols": 10, "rows": 10 },
    "homeRanks": [1, 2],
    "bannedTypes": [],
    "enabledFairy": ["a"],
    "promotionTypes": ["q", "r", "b", "n", "a"]
  }
  ```
  `homeRanks` is the viewer's own home region (White low ranks, Black high ranks).
  Classic `setup.roster` = standard composition, `homeRanks` = `[1,2]`/`[7,8]`.
- `playing`/`ended`: `board` is the per-viewer filtered board keyed by all
  `cols*rows` squares. In CHAOS, `inCheck` is ALWAYS `false` and `checkSquare`
  ALWAYS `null` (no check concept). In CLASSIC, unchanged from v1.
- `result` when set (D.2 below).

### `state.result` (extended)
```json
{ "result": "kingCaptured", "winner": "w", "reason": "kingCaptured" }
```
`result` values: v1 set (`"checkmate" | "stalemate" | "draw" | "resign" |
"opponentLeft"`) PLUS `"kingCaptured"` (chaos win). Chaos draw uses
`"stalemate"`. `winner`: `"w" | "b" | null`.

### `legalMoves`  (server -> client, requester) — shapes unchanged
Same payload as v1: `{ square, moves:[{to,promotion}], hasMoves }`. In chaos,
squares generalize (e.g. `"j10"`) and `promotion:true` marks a pawn reaching the
far rank; nothing else changes.
```json
{ "square": "e2",
  "moves": [ {"to":"e3","promotion":false}, {"to":"e4","promotion":false},
             {"to":"d3","promotion":false} ],
  "hasMoves": true }
```

### `makeMove`  (client -> server) — shape unchanged, promotion generalized
```json
{ "from": "b9", "to": "b10", "promotion": "a" }
```
`promotion` may be any roster promotion type (including a FAIRY letter such as
`"a"`) when a pawn reaches the far rank; otherwise `null`/omitted. If required but
omitted, server defaults per B.5 (queen if present, else first available). Classic
promotion is still `"q"|"r"|"b"|"n"`.

### `moveMade`  (server -> client, per-viewer) — unchanged shape
Own entry may carry a fairy `piece`/name in `text`; opponent entry stays fully
anonymized (`"unknown piece: b9->b10"`), never revealing fairy identity. `from`/`to`
generalize to the current board's squares.
```json
{ "entry": { "ply": 5, "color": "w", "from": "d1", "to": "h5",
             "piece": "a", "san": null, "capture": false,
             "capturedType": null, "promotion": null, "own": true,
             "text": "Amazon d1->h5" },
  "from": "d1", "to": "h5" }
```
(`san` is `null` in chaos — there is no SAN engine; own-move `text` is built from
the catalog name. Opponent entries omit `piece`/`san` exactly as v1.)

### `capture`  (server -> client, both) — unchanged shape
```json
{ "square": "e5", "capturedType": "k", "capturedColor": "b" }
```
`capturedType` may be a fairy letter or `"k"` (a captured king). Reveal is still
gated by `revealCapturedPieceType` (default true). Capturing a king is how chaos
games are won; the `gameOver` (below) follows when it was the LAST king.

### `check`  (server -> client) — CLASSIC ONLY
Emitted only in classic (unchanged from v1). NEVER emitted in chaos.

### `gameOver`  (server -> client, both) — extended reason + generalized board
Only event carrying full opponent info. `fullBoard` keyed by all `cols*rows`
squares. Chaos `fen` is `null`.
```json
{
  "result": "kingCaptured",
  "winner": "w",
  "reason": "kingCaptured",
  "fullBoard": { "a1": {"type":"r","color":"w"},
                 "h5": {"type":"a","color":"w"},
                 "e8": {"type":"k","color":"b"},
                 "j10": null,
                 "...": "all cols*rows keys, both colors visible" },
  "fen": null
}
```
Classic `gameOver` is byte-for-byte v1 (real `fen`, 64 keys, reason
checkmate/stalemate/draw/resign).

---

## E. Unchanged v1 events (still valid, verbatim)

`assigned`, `rejected`, `waiting`, `submitArrangement`, `arrangementAccepted`,
`arrangementRejected`, `gameStart`, `requestMoves`, `errorMsg`, `resign`,
`rematch`, `rematchPending` — all exactly as `CONTRACT.md`. Notes:
- `submitArrangement` now validates against the agreed `roster` and home region
  (classic path validates the standard 16 as before).
- `rematch` returns both players to the `config` phase (renegotiate house rules),
  not directly to setup. `rematchPending` is unchanged.
- `gameStart { turn }` still fires once when both arrangements are in.

---

## F. Event summary (v2 additions)

Client -> Server (adds):
| Event           | Payload                 |
|-----------------|-------------------------|
| `proposeConfig` | `{ config }`            |
| `agreeConfig`   | `{ version }`           |

Server -> Client (adds):
| Event    | Direction  | Payload summary                                  |
|----------|------------|--------------------------------------------------|
| `config` | both       | `{ config, agreed, version, valid, error }`      |

All other events per `CONTRACT.md` (v1), with the additive/generalized changes in
Section D.

---

## G. Invariants both builders MUST uphold (v2)

1. A `state.board` or `moveMade.entry` sent to a viewer NEVER contains an opponent
   piece `type` (standard OR fairy), except a revealed `capturedType`. Only
   `gameOver.fullBoard` reveals opponent types.
2. Every board object always has ALL squares of the CURRENT board as keys
   (`cols*rows`), computed from `boardDims` — never hard-coded 64.
3. Colors are `"w"|"b"`; piece types are catalog letters (`p r n b q k a c h i m
   w`); squares parse via `^([a-z])([0-9]{1,2})$`.
4. Per-viewer emits for `state`/`moveMade`/`check`; `config` is broadcast to both.
5. Chaos has NO check/checkmate: `state.inCheck` always false, no `check` event,
   win only via `kingCaptured`, draw via `stalemate` (no legal moves for the side
   to move).
6. Agreement takes effect only when BOTH `agreed` flags are true for the CURRENT
   `version`; any `proposeConfig` resets both and bumps `version`; stale
   `agreeConfig` (version mismatch) is ignored.
7. Config must satisfy `roster.k >= 1` (cannot ban all kings) and home-region fit
   (`2*max(2,ceil(total/cols)) <= rows`) before setup begins.
8. Classic mode remains behaviorally identical to v1 from `setup` onward
   (chess.js, real FEN, castling `-`, 64-key boards).
9. Pins remain 100% client-side and appear in NO event.
10. If `PLAN-v2.md` and this file disagree, THIS FILE WINS.