# Agent 2 (Backend Builder) — Fog Chess v2 transcript

Scope: implement the complete v2 backend (config/negotiation phase + chaos variant
mode + generalized boards/fog) WITHOUT changing classic behavior from `setup` onward.
Built strictly to `CONTRACT-v2.md` (binding). Files owned/touched: `server.js`,
`src/game.js`, `src/chaos.js` (new), `src/fog.js`. `src/fen.js` left unchanged.
No new dependencies added (chaos is pure JS).

---

## 1. What changed in each file

### `src/chaos.js` (NEW — the entire chaos engine, isolated)
Pure data + functions. No `chess.js`, no sockets, no phase machine. Exports:
- Reference data: `CATALOG`, vector sets (`ORTHO/DIAG/ALL8/KNIGHT/CAMEL`, `VECTORS`),
  `STANDARD_TYPES`, `FAIRY_TYPES`, `ALL_TYPES`, `SUPPORTED_ROWS`, `SQUARE_RE`.
- Coords: `fileIndex`, `fileLetter`, `parseSquare`, `toSquare`, `onBoard`, `allSquares`.
- Rules: `isRoyal`, `countRoyals`, `movesFrom`, `allMoves`, `applyMove`,
  `promotionTypes`, `resolvePromotion`.
- Config/setup: `validateConfig`, `homeRanks`, `homeRankCount`, `rosterTotal`,
  `isSupportedDims`, `validateArrangement`, `buildBoard`, `boardSource`.

### `src/fog.js` (generalized to variable boards + fairy names)
- `allSquares(dims)` / `emptyBoard(dims)` replace the hard-coded 64-square list
  (default dims `{8,8}` for classic). Every board object is keyed by ALL `cols*rows`
  squares.
- `filterBoard(source, viewerColor, dims)` and `revealBoard(source, dims)` now take a
  **board source** abstraction (`{ get(sq) -> {type,color}|null }`) instead of a
  chess.js instance directly. Classic passes the chess.js instance (already has
  `.get`); chaos passes `chaos.boardSource(board)`. fog.js NEVER imports chaos.js.
- `PIECE_NAMES` extended with fairy names (Amazon/Chancellor/Archbishop/Nightrider/
  Camel/Wizard) for OWN-move text only. Opponent move text stays `"unknown piece:
  a->b"` (never names the piece), fairy or not.
- `filterMoveRecord` unchanged in logic; tolerant of `san:null` (chaos).
- Classic-only check helpers (`checkInfoFor`, `findAttackerSquare`, `findKing`) kept,
  operating on the fixed 8x8 `ALL_SQUARES`. `checkInfoFor(null,...)` returns
  not-in-check, so chaos never triggers a check.

### `src/game.js` (mode routing + config/negotiation phase)
- Phase machine now `lobby -> config -> setup -> playing -> ended (-> config on
  rematch)`. `maybeStartConfig()` replaces `maybeStartSetup()`.
- Renamed the server-flags field from `this.config` to `this.options` (reveal flags);
  `this.config` now holds the negotiated house-rules config. All internal
  `filterMoveRecord` calls pass `this.options`.
- New state: `this.config` (defaults to classic preset), `this.agreed{white,black}`,
  `this.configVersion` (integer, starts 1), `this.mode`, `this.boardDims`,
  `this.chaosBoard`.
- Config phase: `sanitizeConfig` (forces classic preset when mode==="classic";
  coerces/filters chaos dims/roster/bans/fairy), `proposeConfig` (store, version++,
  reset both agreements), `agreeConfig` (version guard -> stale resync; both-agree ->
  validate -> setup or reset-with-error), `buildConfigPayload`, `configValidity`.
- Mode routing: `submitArrangement`, `getLegalMoves`, `makeMove`, `startPlaying`,
  `boardSource`, `buildGameOver` all dispatch on `this.isChaos()`. Classic path is the
  original v1 code moved verbatim into `makeMoveClassic`; chaos path is
  `makeMoveChaos` delegating to `chaos.applyMove`.
- `buildState` gains additive fields `mode`, `boardDims`, `config`, `agreed`,
  `configVersion`, and a `setup` block (`roster`, `boardDims`, `homeRanks`,
  `bannedTypes`, `enabledFairy`, `promotionTypes`) during setup. In chaos,
  `inCheck:false`/`checkSquare:null` always. Board filtered via mode's source + dims.
- `resetForRematch` now returns to `phase:"config"` (not setup), bumps version,
  resets agreements, keeps colors and the last agreed config (prefill).
- `handleDisconnect` treats `config` like `setup` (drop to lobby, clear progress).

### `server.js` (wire new events)
- Added `emitConfig()` broadcast helper.
- On connection, `maybeStartConfig()`; if it transitioned, `emitConfig()`.
- New handlers `proposeConfig` -> `emitConfig()+emitState()`, and `agreeConfig` ->
  stale: resync `config` to sender; else `emitConfig()` and `emitState()` if advanced.
- Rematch both -> `emitState()+emitConfig()` (now returns to config).
- Everything else (moveMade per-viewer, capture, check, gameOver, resign, static
  serving, LAN URL printout) unchanged. Check-emit loop calls
  `fog.checkInfoFor(game.chess, c)`; `game.chess` is null in chaos so no check fires.

---

## 2. Chaos engine design

### Descriptor expansion
Every piece is `{ leaps:[[dx,dy]...], slides:[[dx,dy]...], royal, pawn }`. The
CONTRACT tokens (`KNIGHT`, `DIAG`, `ALL8`, `ORTHO`, `CAMEL`, `CAMEL+DIAG`) are expanded
to concrete arrays at module load in `CATALOG`. `dx`=file delta (+ toward j),
`dy`=rank delta (+ toward higher rank). All non-pawn vector sets are closed under
negation, so no per-color mirroring — only pawns depend on color.

Fairy: a=Amazon(ALL8 slide + KNIGHT leap), c=Chancellor(ORTHO slide + KNIGHT leap),
h=Archbishop(DIAG slide + KNIGHT leap), i=Nightrider(KNIGHT **slide**), m=Camel(CAMEL
leap), w=Wizard(CAMEL+DIAG leap).

### Move generation (two primitives)
- **Leap**: target `(f+dx,r+dy)`, legal if on-board and not friendly (capture if
  enemy); blockers ignored.
- **Slide/ride**: for k=1,2,... target `(f+k·dx,r+k·dy)`: off-board -> stop; empty ->
  legal, continue; enemy -> legal (capture) then stop; friendly -> stop (no land).
  A Nightrider is just a slide along a KNIGHT vector — same loop, no special key.
- Targets de-duplicated; promotion flags OR'd per target.

### Pawn (`pawnMovesFrom`)
White `dy=+1`, Black `dy=-1`. Forward 1 if empty. Double-step only from the color's
second rank (White 2, Black `rows-1`) with both squares empty. Diagonal captures
`(f±1,r+dy)` only onto an enemy. No en passant. Promotion flag set when the target is
the far rank (White `rows`, Black `1`).

### makeMove / king-capture / draw (`applyMove`)
Guards from-ownership and that `to` is in `movesFrom`. Records capture (destination
== capture square, no en passant). Moves the piece; if a pawn lands on the far rank,
resolves promotion via `resolvePromotion` (client choice validated against
`promotionTypes`; default `q` if present else first available; if none, pawn stays).
Then: opponent royal count == 0 -> `{result:"kingCaptured", winner:mover}`; else if
the NEXT side to move has no legal move -> `{result:"stalemate", winner:null}`.
Kings are ordinary capturable pieces (`royal:true`); multiple kings supported —
capturing a non-last king just removes it and play continues.

### Config validation (`validateConfig`) — CONTRACT B.6/G7
`mode∈{classic,chaos}`; dims supported (cols 8..10, rows 8|10); every roster type is a
catalog letter, not banned, and (if fairy) in `enabledFairy`; `roster.k>=1`;
home-region fit `2*max(2,ceil(total/cols)) <= rows`. Returns `{valid,error}` with
human-readable errors.

### Home region + arrangement
`N = max(2, ceil(total/cols))`; White home ranks `1..N`, Black `rows-N+1..rows`.
`validateArrangement` checks every square parses + on-board + in the submitter's home
region, no duplicates, each type enabled/allowed, and the placed multiset EXACTLY
equals the roster.

---

## 3. Config phase + agreement-reset

Server holds one shared `config` + `agreed{white,black}` + integer `configVersion`.
`proposeConfig` sanitizes (classic forced to preset), stores, `version++`, resets BOTH
agreements, broadcasts `config`. `agreeConfig{version}` is ignored (with a resync
re-broadcast) when the version != current; otherwise sets that side's agreed=true.
Only when BOTH are true for the CURRENT version is the config validated: valid ->
`setup`; invalid -> stay in `config`, reset agreements, broadcast `config` with
`valid:false`+`error`. The `config` payload's `valid`/`error` are computed live from
`validateConfig(this.config)` on every broadcast. Rematch returns both to a fresh
`config` phase (version bumped, agreements cleared, last config retained for prefill).

---

## 4. Keeping classic identical

The classic move/legal/setup/gameOver code is the original v1 logic, only relocated
behind `isChaos()` routing (`makeMoveClassic`, classic branch of `getLegalMoves`,
`buildFen`+chess.js in `startPlaying`, real `fen` in `buildGameOver`). Classic config
is force-overwritten to the exact preset, so tampering can't change it. Classic still
uses `chess.js`, real check/checkmate/stalemate/draw, castling `-`, `skipValidation`
FEN, 64-key boards, standard 16-piece composition validated by `src/fen.js`
(untouched). The only new thing before a classic game is a trivial both-agree config.

---

## 5. Fog generalization

fog.js iterates `allSquares(dims)` of the current board (never 64 hard-coded). Own
piece -> `{type,color}` (type may be a fairy letter); opponent -> `{occupied:true}`
(any class, including fairy — identity never leaks); empty -> null. `revealBoard`
(gameOver only) shows every occupied square as `{type,color}`. Mode-agnostic via the
`{get(sq)}` source; classic passes chess.js, chaos passes `chaos.boardSource(board)`.

---

## 6. Smoke scripts (in scratchpad, not committed)

`smoke-chaos.js` — 54 assertions, ALL PASS:
- Square parsing: `a1/a10/j10/h8` parse correctly (file=letter, rank=digits); `j10`
  round-trips; 8x8=64 / 10x10=100 squares; `j10` present on 10x10.
- Move-gen 8x8: knight d4 = 8 targets; bishop d4 blocked by friendly f6 + captures
  enemy b2 then stops; **amazon d4 empty = 35** (queen 27 + knight 8); **nightrider
  d4 rides** incl. long rides `f8`, `h6`, `b8`; nightrider blocked by friendly on ray.
- Pawns: white d2 single+double; captures added with enemies on c3/e3; d3 single only;
  black d7 double; promotion flag on d7->d8; black double on 10-tall from rank 9.
- King capture: Q x last king -> `kingCaptured` win; capturing 1 of 2 kings does NOT
  end. Draw: boxed corner army (king a1 + immobile rank-1/blocked pawns) yields
  `allMoves===0`; via `applyMove`, the side-to-move with no moves -> `stalemate` draw.
- Config validation: valid small config; no-king invalid; roster-too-large invalid;
  fairy-not-enabled invalid then valid when enabled. Home ranks for 8x8 and N=3 case.
  Promotion type order `[q,r,b,n,a]`.
- Fog: filtered board keyed by 64 (and 100 on 10x10); own amazon shows type; opponent
  nightrider/king/wizard `{occupied:true}` with NO type; empty null; reveal shows all.
- Arrangement: valid white/black; out-of-home-region rejected; wrong multiset rejected.

`smoke-game.js` — 55 assertions, ALL PASS:
- Classic: lobby->config->setup->playing via both-agree; standard arrangement; e2->e4;
  no leak in black's state; resign -> real fen gameOver; 64-key boards.
- Chaos 10x10 + fairy: stale agree ignored; both-agree valid -> setup; 100-key board;
  setup roster/home ranks (`[1,2]`/`[9,10]`)/promotion types; arrangements on
  ranks 1-2 / 9-10; amazon legal moves; can't move opponent square. **Fog leak check:
  black sees white amazon/nightrider as `{occupied:true}` (no type), own king visible;
  inCheck always false.** Pawn e2->e3 record has `san:null`, `piece:'p'`; opponent
  move log anonymized (`"unknown piece..."`), own move named (`"Pawn ..."`); gameOver
  `fen:null`, 100-key fullBoard revealing black amazon.
- Invalid config (no king) blocks setup, stays config, resets agreements, payload
  `valid:false`+king error. Propose resets both agreements and bumps version.

Server boot: `node server.js` prints
```
Fog Chess running at:
  http://localhost:3000
  http://192.168.1.216:3000
  http://192.168.56.1:3000
```
and `GET /` returns HTTP 200 (static `public/` served).

---

## 7. Risks / notes for testers

- **Fog-leak surfaces (priority #1).** The generalized `filterBoard`/`revealBoard` and
  the new fairy type set are the highest-risk area. Verified via automated leak checks,
  but socket testers should confirm over real sockets that `state.board` and
  `moveMade.entry` NEVER carry an opponent type (fairy shows as `{occupied:true}`), and
  that every board object has exactly `cols*rows` keys on 8x8/10x8/10x10. Only
  `gameOver.fullBoard` reveals opponent types. `capture.capturedType` (incl. `"k"` and
  fairy letters) is an intentional reveal gated by `revealCapturedPieceType`.
- **Classic regression (priority #2).** Classic path is v1 code relocated behind mode
  routing; not rewritten. Full classic game (check, en passant, promotion, checkmate,
  stalemate, draw, resign) should behave byte-for-byte like v1 aside from the additive
  `mode`/`boardDims`/config fields and the new pre-setup config agree.
- **No check in chaos.** `inCheck` always false, no `check` event, `checkSquare` null.
  The server's check-emit loop is a no-op in chaos because `game.chess` is null. Draw
  is strictly "side to move has no legal move" (`result:"stalemate"`, winner null).
- **Rank-10 parsing.** All parsing uses `^([a-z])([0-9]{1,2})$`; `sq[1]` is never used
  for the rank. `to.slice(1)` is used where a rank number is needed.
- **Rematch goes to `config`, not `setup`** (renegotiation), version bumped so any
  stale `agreeConfig` is ignored.
- **Promotion to fairy** is allowed when the fairy type is a roster promotion option;
  omitted choice defaults to `q` (else first available; else pawn stays on far rank).
- Chaos `moveMade.entry.san` is always `null` (no SAN engine); own-move `text` is built
  from the catalog name.
