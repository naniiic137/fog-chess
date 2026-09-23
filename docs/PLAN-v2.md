# Fog Chess - Implementation Plan (v2: Modes, Chaos Engine, Negotiation)

Authoritative v2 plan. Extends v1 (`PLAN.md`) without breaking it. Paired with
`CONTRACT-v2.md`, which EXTENDS `CONTRACT.md`. Where this plan and `CONTRACT-v2.md`
disagree about a Socket.io payload, **`CONTRACT-v2.md` wins**. Where v2 is silent,
v1 (`PLAN.md` / `CONTRACT.md`) still governs.

---

## 0. The non-negotiable invariant (unchanged from v1)

The rules engine is standard & full-information. Fog of war is ONLY a per-viewer
VIEW FILTER applied right before emitting:

- viewer's own piece  -> `{ type, color }`
- opponent's piece    -> `{ occupied: true }`   (NEVER type/color, EVER)
- empty               -> `null`

The raw board is emitted in exactly one place: `gameOver.fullBoard`. This holds
for BOTH modes. In chaos, "type" now includes fairy letters (`a c h i m w`); an
opponent fairy piece is STILL just `{occupied:true}` — its exotic identity must
never leak. All hidden-info logic stays inside `src/fog.js`.

---

## 1. Two modes

### classic  (the EXISTING game — DO NOT redesign)
- Uses `chess.js` exactly as v1. Real check/checkmate/stalemate/draw, en passant,
  promotion. Standard 16-piece composition, 8x8, castling dropped, back-rank pawns
  allowed, `skipValidation:true` FEN loading. This is the DEFAULT.
- The classic code path (`src/fen.js`, chess.js usage in `src/game.js`) is
  untouched except that `game.js` now *routes* to it by `mode`. No behavioral
  change once a classic game reaches `setup`/`playing`.

### chaos  (NEW — data-driven variant engine, `src/chaos.js`)
- Does NOT use chess.js. Win condition = KING CAPTURE. Custom piece counts
  (multiple queens AND multiple kings), fairy pieces, piece bans, variable board
  dimensions. All chaos rules live in `src/chaos.js`; `game.js` just routes.

The two modes share: the config/negotiation phase, the fog filter (generalized),
the socket contract, and the per-viewer `state` broadcast.

---

## 2. File / folder structure and ownership (STRICT — prevents collisions)

```
hidden chess/
  server.js                 [BACKEND]  route handlers add proposeConfig/agreeConfig; mode-agnostic
  src/
    game.js                 [BACKEND]  phase machine + config/negotiation + mode routing
    chaos.js                [BACKEND]  NEW: catalog, move-gen, king-capture, board dims, chaos setup
    fen.js                  [BACKEND]  classic-only (unchanged logic)
    fog.js                  [BACKEND]  generalized to variable boards + fairy names
  public/
    index.html              [FRONTEND] add config screen; generalized board container
    style.css               [FRONTEND] variable grid, fairy badges, config controls
    client.js               [FRONTEND] config screen, variable-dim rendering, fairy render, roster tray
  PLAN.md / CONTRACT.md               v1 docs (leave in place)
  PLAN-v2.md / CONTRACT-v2.md         v2 docs (this + contract)
  transcripts/agent1-planner-v2.md    planner transcript
```

- **BACKEND builder owns:** `server.js`, everything under `src/` (incl. new
  `src/chaos.js`).
- **FRONTEND builder owns:** everything under `public/`.
- Neither edits the other's files or the docs. Only coupling = `CONTRACT-v2.md`.

Isolation rule: ALL chaos logic lives in `src/chaos.js`. `game.js` never contains
movement math; it calls `chaos.*`. `fog.js` never knows chaos rules; it only
iterates squares and asks a source for the piece at each square.

---

## 3. Coordinate / board-dimension system

`boardDims = { cols, rows }` (cols = width/files, rows = height/ranks). Support at
least `8x8`, `10x8`, `10x10`. General up to 10x10 (design tolerates <=26 cols).

### 3.1 Square strings
- File = a single lowercase letter, `a` + col index (0-based): cols 0..9 => `a`..`j`.
- Rank = 1-based integer `1..rows`, printed in decimal (can be two digits: `10`).
- Square = `<fileLetter><rankNumber>`: `a1`, `j7`, `a10`, `j10`.
- **Parsing rule (unambiguous):** leading letters are the file, trailing digits
  are the rank. Regex: `^([a-z])([0-9]{1,2})$`. Because cols <= 10 <= 26, the file
  is always exactly ONE letter, so `a10` = file `a`, rank `10` (never ambiguous).
- Classic mode is the special case `8x8` and its squares are exactly `a1`..`h8`,
  identical to v1.

### 3.2 Coordinate helpers (implement in `src/chaos.js`, reused by `fog.js`)
```
fileIndex(letter)      // 'a'->0 ... 'j'->9
fileLetter(index)      // 0->'a' ... 9->'j'
parseSquare(sq)        // -> { f:0-based col, r:1-based rank } | null
toSquare(f, r)         // (f 0-based, r 1-based) -> "a1"
onBoard(f, r, dims)    // 0<=f<cols && 1<=r<=rows
allSquares(dims)       // ordered list of every "cols*rows" square string
```
`allSquares` is the single source of "which keys must appear in every board
object." Every filtered/full board is keyed by ALL `cols*rows` squares — never a
hard-coded 64.

---

## 4. Movement descriptor (the heart of chaos)

Every piece — standard and fairy — is expressed with ONE uniform descriptor. The
engine has exactly TWO movement primitives, so there are only two code paths.

```
descriptor = {
  leaps:  [[dx,dy], ...],   // single jumps; ignore intervening squares (range 1)
  slides: [[dx,dy], ...],   // ride: repeat this vector until blocked/off-board
  royal:  true|false,       // king-like; capturable; counts toward king-capture win
  pawn:   true              // present ONLY on pawns; fully special-cased (Section 6)
}
```
- `dx` = file delta (columns, +=toward `j`), `dy` = rank delta (+=toward higher rank).
- **Leap**: target = (f+dx, r+dy). Legal if on-board and not friendly (capture if
  enemy). Blockers between are irrelevant.
- **Slide**: for k=1,2,...: target = (f+k·dx, r+k·dy). If off-board -> stop. If
  empty -> legal, continue. If friendly -> stop (cannot land). If enemy -> legal
  (capture), then stop.
- **Riders are just slides.** A "Nightrider" is a slide whose vector is a knight
  vector `[1,2]`. There is NO separate `rides` key; the engine treats every
  `slides` entry as "repeat until blocked," so unit vectors (rook/bishop) and
  leaper vectors (nightrider) use the identical loop. (If a reader prefers the
  word `rides`, it is a documentation alias for `slides` — the JSON key is
  `slides`.)
- All descriptors here are color-symmetric (the vector sets are closed under
  negation), so NO per-color mirroring is needed for any non-pawn piece. Only
  pawns depend on color.

### 4.1 Shared vector sets
```
ORTHO  = [[1,0],[-1,0],[0,1],[0,-1]]
DIAG   = [[1,1],[1,-1],[-1,1],[-1,-1]]
ALL8   = ORTHO + DIAG
KNIGHT = [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]]
CAMEL  = [[1,3],[3,1],[3,-1],[1,-3],[-1,-3],[-3,-1],[-3,1],[-1,3]]
```

### 4.2 Standard pieces AS DATA
| letter | name   | descriptor                         |
|--------|--------|------------------------------------|
| `p`    | Pawn   | `{ pawn:true }`                    |
| `n`    | Knight | `{ leaps: KNIGHT }`                |
| `b`    | Bishop | `{ slides: DIAG }`                 |
| `r`    | Rook   | `{ slides: ORTHO }`               |
| `q`    | Queen  | `{ slides: ALL8 }`                |
| `k`    | King   | `{ leaps: ALL8, royal:true }`     |

### 4.3 Fairy roster (chosen set — wild, long-distance)
| letter | name       | descriptor                          | flavor                          |
|--------|------------|-------------------------------------|---------------------------------|
| `a`    | Amazon     | `{ slides: ALL8, leaps: KNIGHT }`   | Queen + Knight — the wildest    |
| `c`    | Chancellor | `{ slides: ORTHO, leaps: KNIGHT }`  | Rook + Knight                   |
| `h`    | Archbishop | `{ slides: DIAG, leaps: KNIGHT }`   | Bishop + Knight                 |
| `i`    | Nightrider | `{ slides: KNIGHT }`                | rides knight vectors, long-range|
| `m`    | Camel      | `{ leaps: CAMEL }`                  | (3,1) long leaper               |
| `w`    | Wizard     | `{ leaps: CAMEL + DIAG }`           | Camel + Ferz — long teleporty   |

All fairy pieces are `royal:false` (capturable, non-royal). Letters `a c h i m w`
never collide with standard `p r n b q k`. This exact table is duplicated in
`CONTRACT-v2.md` as the shared "piece catalog"; if they ever differ, CONTRACT
wins.

---

## 5. Chaos move generation & win/draw

### 5.1 Board representation (in `src/chaos.js`)
`board` = plain object `{ [square]: { type, color } | absent }`. Royalty is looked
up from the catalog (`CATALOG[type].royal`), not stored per-piece. `dims` is held
on the game. There is NO chess.js instance in chaos.

### 5.2 Pseudo-legal == legal (no check concept)
A move is legal iff: destination is on-board, the piece's descriptor permits it
(slides blocked by pieces; leaps jump), and the destination does not hold a
FRIENDLY piece. There is NO self-check / check / checkmate restriction — you may
move into danger and you may leave your king "hanging."

`movesFrom(board, sq, dims)` returns `[{ to, promotion:bool }]`:
- Pawn (`CATALOG[type].pawn`): use Section 6.
- Else: for each `leaps` vector, one step; for each `slides` vector, repeat until
  blocked (per Section 4). Emit each on-board non-friendly target. `promotion` is
  false for all non-pawn moves.
- De-duplicate targets and collapse promotion targets to a single
  `{to, promotion:true}` entry (mirrors v1 legalMoves contract).

`allMoves(board, color, dims)` = union of `movesFrom` over every square holding a
`color` piece. Used for draw detection.

### 5.3 makeMove (chaos)
`makeMove(color, from, to, promotion)`:
1. Guard: phase playing, `turn===color`, `from` holds a `color` piece, and `to`
   is in `movesFrom(from)`. Else `{ok:false,error}`.
2. Capture: if `board[to]` exists (always enemy, since friendly is illegal),
   record `capturedType`/`capturedColor`; the capture square is `to` (NO en
   passant in chaos, so capture square == destination always).
3. Move the piece: `board[to] = board[from]; delete board[from]`.
4. Promotion: if the piece is a pawn reaching the far rank (Section 6.4), set
   `board[to].type = promotion` (validated against roster promotion options;
   default per Section 6.4).
5. Append a full MoveRecord (same shape as v1 plus fairy-capable `piece`), flip
   `turn`.
6. **Win check (king capture):** after the capture, count the just-moved side's
   opponent's royals on the board. If that count === 0 -> game over,
   `winner = mover`, `reason = "kingCaptured"`. (Capturing a non-last king simply
   removes it; the game continues.)
7. **Draw check:** else, if `allMoves(board, turn /*the NEW side to move*/, dims)`
   is empty -> game over, `winner = null`, `reason = "stalemate"` (result string
   `"stalemate"`). This is the stalemate-like draw.

### 5.4 Legal moves request (chaos)
`getLegalMoves(color, square)` = same contract as classic: empty unless playing,
requester's turn, and the square holds the requester's own piece; else
`movesFrom` mapped to `[{to,promotion}]`.

---

## 6. Chaos pawn rules (variable board heights)

Pawns keep classic feel; no en passant. Direction and the double-step rank are
derived from `dims`, not from per-pawn origin tracking.

- **Direction (per color):** White pawns move toward HIGHER ranks (`dy = +1`);
  Black pawns toward LOWER ranks (`dy = -1`). (Same as classic.)
- **Forward 1:** `(f, r+dy)` if empty and on-board.
- **Double-step (starting-rank logic):** allowed ONLY when the pawn currently sits
  on its color's SECOND rank, defined by board height:
  - White second rank = `2`.
  - Black second rank = `rows - 1`.
  Both the intermediate `(f, r+dy)` and destination `(f, r+2·dy)` must be empty.
  A pawn placed on the very back rank (White rank 1 / Black rank `rows`) does NOT
  get a double-step until it walks to its second rank — identical in spirit to
  the v1 back-rank-pawn rule. A pawn already past its second rank never
  double-steps. No per-pawn memory required; the rule is a pure function of the
  current square and `dims`.
- **Diagonal capture:** `(f-1, r+dy)` and `(f+1, r+dy)`, each legal only if it
  holds an ENEMY piece (captures a king too, which can win).
- **Promotion (far rank):** White far rank = `rows`; Black far rank = `1`. A pawn
  move landing on the far rank sets `promotion:true` in legalMoves and requires a
  promotion type in makeMove.
  - **Promotion options** = current roster piece types that are (a) enabled/not
    banned, (b) NOT royal (no promoting to a king), and (c) not `p` itself. If the
    client omits a choice, default to `q` when a queen is in the roster, else the
    first available promotion type. If NO promotion type is available (degenerate
    roster), the pawn simply stays a pawn on the far rank (no promotion).

---

## 7. Setup for chaos (home-region computation)

Both armies are IDENTICAL (a single shared `roster` in the agreed config), so both
players place the same multiset on their own home region.

- `total = sum(roster values)`.
- **Home-rank count** `N = max(2, ceil(total / cols))`. (min 2 ranks; enough
  squares `N*cols >= total`.)
- **Regions:** White home = ranks `1..N`; Black home = ranks `rows-N+1 .. rows`.
- **Non-overlap validation:** require `2*N <= rows`. If violated, the config is
  INVALID (roster too large for the board) — it cannot be agreed; the config phase
  surfaces the error (Section 8) and blocks the transition to setup.
- Full freedom within the home region, including pawns on the very back rank.
- **Arrangement validation (`chaos.validateArrangement(placement, color, config)`):**
  - every square matches `^([a-z])([0-9]{1,2})$` and is on-board for `dims`;
  - every square is within the submitter's home region (the N ranks);
  - no duplicate squares;
  - the piece-type multiset equals the roster EXACTLY;
  - every placed type is enabled (in roster, not in `bannedTypes`, and if fairy,
    in `enabledFairy`);
  - roster already guarantees >=1 king (enforced at config-agree time), so at
    least one royal is placed.
- Tray shows custom counts: the client renders one tray slot per roster type
  (including fairy letters and multiple kings/queens) with an `xN` remaining
  badge, computed from `roster` minus placed.

Classic setup is unchanged: fixed roster `{p:8,r:2,n:2,b:2,q:1,k:1}`, home ranks
`1-2`/`7-8`, validated by the existing `src/fen.js` path.

---

## 8. House-rules negotiation phase (NEW: `phase:"config"`)

A new phase between lobby and setup. Both players must agree the SAME config
before setup begins.

### 8.1 Shared config object (server-held)
```
config = {
  mode: "classic" | "chaos",
  boardDims: { cols, rows },     // chaos; classic is implicitly 8x8
  bannedTypes: [ ...typeLetters ],
  roster: { [type]: count, ... },// counts per allowed type (incl. multi king/queen + fairy)
  enabledFairy: [ ...fairyLetters ]
}
```
Server-held agreement tracking:
```
agreement = { white:false, black:false }
configVersion = <integer nonce>   // increments on EVERY edit
```

### 8.2 Presets
- **Classic preset:** `{ mode:"classic", boardDims:{cols:8,rows:8},
  roster:{p:8,r:2,n:2,b:2,q:1,k:1}, bannedTypes:[], enabledFairy:[] }`.
- **Chaos default preset:** same standard roster on 8x8 with `enabledFairy:[]`,
  which players then edit (add fairy, change counts, ban types, resize board).

The default config on entering `config` is the Classic preset with
`agreement={false,false}` — so classic still "just works" via a quick both-agree
(essentially an empty negotiation).

### 8.3 Events & agreement-reset state machine
- `proposeConfig { config }` (client->server): server sanitizes & stores the new
  config, does `configVersion++`, RESETS `agreement.white = agreement.black =
  false`, and broadcasts `config` to both. Any edit by EITHER player invalidates
  any prior agreement — so both must re-agree the CURRENT proposal.
- `agreeConfig { version }` (client->server): if `version === configVersion`, set
  the sender's `agreement[side] = true`. If the versions differ (stale agree
  against an edited proposal), IGNORE it and re-broadcast `config` so the client
  resyncs. When BOTH agreements are true, VALIDATE the config (Section 8.4); if
  valid, transition to `setup` built from the agreed config and broadcast `state`;
  if invalid, keep phase `config`, reset agreements, broadcast `config` with an
  `error` string.
- `config { config, agreed:{white,black}, version, valid, error }`
  (server->client, both): broadcast after any config change or agree. Drives the
  live "opponent's proposal" view and each side's Agree state.

Rule restated: **agreement takes effect only when BOTH have pressed Agree on the
CURRENT `configVersion`. Any edit resets both agreements and bumps the version.**

### 8.4 Config validation (must pass before setup)
- `mode` in {classic, chaos}. Classic forces the classic preset (server overrides
  any tampering).
- Chaos: `cols` in a supported set (>=8, <=10), `rows` in supported set (8 or 10),
  at least the three combos `8x8`, `10x8`, `10x10`.
- `roster` has integer counts >= 0; total >= (kings + at least a couple pieces);
  **>= 1 king** (`roster.k >= 1`) — you may NOT ban/zero all kings.
- Every roster type is a known catalog letter; fairy types appear only if listed
  in `enabledFairy`; no roster type is in `bannedTypes`.
- Bans: a banned type is removed from roster/tray and cannot be placed; bans work
  for ALL types (`p..k` and fairy), guarded by the >=1-king rule.
- Home-region fit: `2 * max(2, ceil(total/cols)) <= rows` (Section 7).

### 8.5 Phase machine (v2)
```
 lobby --both connected--> config --both agree(valid)--> setup --both ready--> playing --end--> ended
   ^                                                                                              |
   +--------------------------------- both rematch ----------------------------------------------+
                                   (rematch returns to CONFIG, colors kept)
```
- lobby->config: fires when both slots filled (replaces v1's lobby->setup).
- config->setup: on both-agree + valid; server builds the initial position holder
  (classic: awaits arrangements->FEN; chaos: empty `board` + `dims` + `roster`).
- setup->playing: both `submitArrangement` valid. Classic builds FEN + chess.js
  (unchanged). Chaos builds the `board` map from the two placements.
- playing->ended: classic via chess.js end detection (unchanged); chaos via
  king-capture / no-moves (Section 5.3). resign works in both.
- ended->config: both `rematch` -> reset to a FRESH config phase (colors kept), so
  players can renegotiate house rules each match. (v1 returned to setup; v2
  returns to config to allow re-negotiation. Classic players just re-agree.)

---

## 9. Fog filter generalization (`src/fog.js`)

`fog.js` remains the ONLY hidden-info module. Generalize it to variable boards and
fairy names without teaching it any chaos rules.

- Introduce a "board source" abstraction: an object exposing `get(sq) ->
  {type,color} | null`. Classic passes the chess.js instance (already has `.get`);
  chaos passes a thin wrapper `{ get: sq => board[sq] || null }`. `fog.js` never
  imports `chaos.js`.
- `allSquares(dims)` / `emptyBoard(dims)` replace the hard-coded 64-square list.
  Every board object is keyed by all `cols*rows` squares.
- `filterBoard(source, viewerColor, dims)`: iterate `allSquares(dims)`; own ->
  `{type,color}`; opponent -> `{occupied:true}`; empty -> `null`. Fairy pieces of
  the opponent are STILL `{occupied:true}` — identical neutral token; type never
  emitted.
- `revealBoard(source, dims)`: full `{type,color}|null` for all squares. gameOver
  only.
- `filterMoveRecord`: unchanged logic; extend `PIECE_NAMES` to include fairy names
  (Amazon, Chancellor, Archbishop, Nightrider, Camel, Wizard) for OWN-move text.
  Opponent moves stay fully anonymized (no `piece`, no `san`) exactly as v1 — a
  fairy opponent move still reads `"unknown piece: e2->e4"`.
- `checkInfoFor`: classic only. In chaos there is no check; `game.js` supplies
  `inCheck:false, checkSquare:null` for chaos states (do not call chess.js).

Result: the filtered board shape and the leak invariant are byte-for-byte the same
across modes; only the key set (square list) and the set of possible OWN types
grow.

---

## 10. Backend wiring changes (`server.js`, `src/game.js`)

- `server.js`: add handlers `proposeConfig` and `agreeConfig` (Section 8.3). All
  emit helpers stay per-viewer. Every state-changing handler still ends with the
  per-viewer `state` broadcast. `makeMove`/`requestMoves`/`submitArrangement`/
  `resign`/`rematch` handlers are mode-agnostic — they call `game.*`, which routes.
- `src/game.js`:
  - Add `phase:"config"`, `config`, `agreement`, `configVersion` to state; add
    `proposeConfig`, `agreeConfig` methods with reset logic.
  - `maybeStartConfig()` replaces `maybeStartSetup()` for lobby->config.
  - Mode routing: `submitArrangement`, `getLegalMoves`, `makeMove` dispatch to the
    classic path (existing chess.js code) when `config.mode==="classic"`, else to
    `src/chaos.js`.
  - `buildState(viewerColor)` gains `mode`, `boardDims`, and, during `config`, the
    config/agreement fields; during `setup`, `roster` + `homeRanks` + `bannedTypes`
    for the tray. For chaos playing/ended it feeds the chaos board wrapper to
    `fog.filterBoard` and forces `inCheck:false`.
  - `buildGameOver()` uses `fog.revealBoard` over the right source + `dims`; chaos
    `fen` is `null`; `reason` may be `"kingCaptured"`.
  - `resetForRematch()` returns to `phase:"config"` (fresh negotiation), clearing
    board/arrangements/roster-derived state, keeping colors.
- `src/chaos.js` exports: `CATALOG`, vector sets, coord helpers, `allSquares`,
  `validateConfig`, `homeRanks(config,color)`, `validateArrangement`,
  `buildBoard(whitePlacement, blackPlacement, config)`, `movesFrom`, `allMoves`,
  `makeMove`, `countRoyals`. `game.js` owns the phase machine; `chaos.js` owns the
  rules.

---

## 11. Frontend changes (`public/`)

- **Config screen (new `#screen-config`):** mode toggle (Classic/Chaos); when
  Chaos: board-dims picker (8x8 / 10x8 / 10x10), roster count steppers per type
  (standard + fairy, +/- with the >=1-king guard shown), ban toggles (checkbox per
  type; disables that type in roster/tray), fairy enable toggles (drives which
  fairy steppers appear). A live "Opponent's proposal" panel mirrors the shared
  `config`. An **Agree** button sends `agreeConfig{version}`; ANY local edit sends
  `proposeConfig{config}` (which resets both agrees) so the UI must reflect
  "agreement reset" whenever `config` arrives with `agreed` cleared. Show the
  `error` string when `valid:false`.
- **Variable-dim board rendering:** the current code hard-codes `FILES=a..h` and
  8 rows. Replace with dims-driven generation: read `state.boardDims`, build files
  `a..(a+cols-1)`, ranks `1..rows`, set CSS grid to `repeat(cols,1fr)` /
  `repeat(rows,1fr)`, orient with the viewer at the bottom (White: rank `rows`..1;
  Black: rank 1..rows with files reversed). Square parsing uses the
  `^([a-z])([0-9]{1,2})$` rule (handles `a10`). `orderedSquares`, `isLight`,
  `homeRanks`, setup grid aspect-ratio all become dims-driven.
- **Fairy rendering:** standard pieces keep unicode glyphs. Fairy pieces (own)
  render as a colored letter BADGE (`A C H I M W`) using the catalog names for
  tooltips. Opponent pieces — standard OR fairy — render the SAME neutral hidden
  token as v1 (`.unknown`); never a badge, never a glyph, never a type.
- **Roster-aware tray & setup:** tray slots come from `state.roster` (not fixed
  16); home region comes from `state.homeRanks`; the `N`-rank setup grid replaces
  the fixed 2-rank grid. Ready enabled when placed multiset == roster.
- **End screen:** unchanged except it renders the dims-driven full board and shows
  the `kingCaptured` result string ("King captured — <winner> wins").
- Classic still renders identically because classic sends `boardDims:{8,8}`,
  fixed roster, and standard glyphs.

---

## 12. Build order (recommended)

1. **CONTRACT-v2 freeze** (this repo) — both builders code against it.
2. **Backend: config phase.** `game.js` config/agreement + `server.js`
   proposeConfig/agreeConfig; classic preset both-agree -> setup. Verify classic
   end-to-end still plays (backward-compat gate).
3. **Frontend: config screen** + generalized board container (still 8x8 classic).
   Verify two tabs negotiate + play classic exactly like v1.
4. **Backend: `chaos.js` engine** — catalog, coords, `allSquares`, move-gen
   (leaps/slides), `makeMove`, king-capture + no-move draw, `buildBoard`,
   validateConfig/validateArrangement/homeRanks.
5. **fog.js generalization** — board-source abstraction, `allSquares(dims)`, fairy
   names. Re-verify classic filtering unchanged.
6. **Frontend: variable dims + roster tray + fairy badges** — render chaos setup
   and play; opponent pieces always hidden token.
7. **Chaos wiring end-to-end** — 8x8 chaos with standard roster, then multi-king,
   then fairy, then 10x8 and 10x10.
8. **Leak audit (priority #1)** — drive full chaos games (fairy + 10x10) through
   real sockets; assert no `state.board`/`moveMade.entry` ever carries an opponent
   `type`; assert every board has exactly `cols*rows` keys.

---

## 13. Risks / notes for builders & testers

- **PRIORITY #1 — fog leak with variable boards + fairy pieces.** The new type set
  (`a c h i m w`) and non-64 boards are the highest-risk regression surface.
  Testers must confirm opponent fairy pieces are `{occupied:true}` (never a
  badge/letter), every board object has all `cols*rows` keys, and only
  `gameOver.fullBoard` reveals opponent types. Reuse the v1 automated leak audit,
  extended to chaos/fairy/10x10.
- **PRIORITY #2 — classic backward-compat.** Once past the (new, trivial) config
  agree, classic must behave byte-for-byte like v1: same chess.js path, same FEN,
  same events, same board shape. Do not refactor the classic path; only route to
  it. Regression-test a full classic game incl. check, en passant, promotion,
  checkmate, resign, rematch.
- **King-capture, not check.** In chaos there is NO check/checkmate/self-check.
  Moving into danger is legal; `inCheck` is always false; win only when opponent
  royals hit 0. Do not accidentally import chess.js legality into chaos.
- **Draw = side-to-move has no legal moves** (`reason:"stalemate"`,
  result `"stalemate"`).
- **Agreement reset:** any `proposeConfig` bumps `configVersion` and clears both
  agrees; stale `agreeConfig{version}` (mismatched version) is ignored. This
  guarantees both agree the identical final config.
- **Square parsing at rank 10:** always parse file = leading letter, rank =
  trailing digits. Never `parseInt(sq[1])` (breaks on `a10`). Both builders must
  use the shared parse rule.
- **Home-region overlap:** reject configs where `2*N > rows`. Surface the error in
  the config screen; never enter setup with an impossible roster/board.
- **Promotion to fairy:** in chaos, `makeMove.promotion` may be a fairy letter if
  that type is in the roster; validate against roster promotion options.
- **Per-viewer emits unchanged:** `state`/`moveMade`/`check`/`config` per-viewer or
  per-both as specified; never a single shared board `io.emit`.
- **Contract precedence:** if PLAN-v2 and CONTRACT-v2 differ, CONTRACT-v2 wins.

### Critical Files for Implementation
- C:\Users\Naniii\Documents\Github\hidden chess\CONTRACT-v2.md
- C:\Users\Naniii\Documents\Github\hidden chess\src\chaos.js  (NEW)
- C:\Users\Naniii\Documents\Github\hidden chess\src\game.js
- C:\Users\Naniii\Documents\Github\hidden chess\src\fog.js
- C:\Users\Naniii\Documents\Github\hidden chess\public\client.js