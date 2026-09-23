# Agent 4 (Test Agent A) — Fog Chess v2 BACKEND test transcript

Scope: backend correctness of the new **chaos** engine + **config negotiation**,
**classic** regression, and — highest priority — verifying **the fog never leaks
opponent piece types** (including fairy pieces, on 8x8/10x8/10x10). Tested by driving
the REAL running server (`server.js`) with scripted `socket.io-client` clients over
dedicated ports. No app source files were modified; all scripts live in the scratchpad.

Asserted against `CONTRACT-v2.md` (binding), falling back to `CONTRACT.md` (v1) where v2
is silent. Read: `CONTRACT-v2.md`, `PLAN-v2.md`, `CONTRACT.md`, `transcripts/agent2-backend-v2.md`,
and skimmed `server.js`, `src/chaos.js`, `src/game.js`, `src/fog.js`.

## Verdict: PASS. 265/265 assertions across 9 scripts. ZERO fog leaks. No bugs found.

The fog-leak audit **PASSED on 8x8, 10x8, and 10x10 WITH fairy pieces** (Amazon,
Chancellor, Archbishop, Nightrider, Camel, Wizard). Opponent squares are always exactly
`{occupied:true}`; opponent `{type,color}` appears in NO event except `gameOver.fullBoard`.

---

## Method / harness

Because `server.js` holds a single in-memory `FogChessGame` singleton, each scenario
spawns a **fresh server process on its own port** (`lib2.startServer(port)` via
`child_process.spawn` with `PORT=<n>`), so every test starts from a clean lobby. Ports
used: 3141–3220 (deliberately avoiding 3100 used by the sibling test agent). Two scripted
clients W and B drive the full v2 flow `lobby -> config -> setup -> playing -> ended`.

Harness files (scratchpad):
- `lib2.js` — `Client`, `startServer`/`stopServer`, **dims-aware + fairy-aware**
  `auditFilteredBoard`/`auditClientLog` (own type set `[prnbqkachimw]`; opponent cells must
  be EXACTLY `{occupied:true}`; expects `cols*rows` keys, not hard-coded 64).
- `driver.js` — `toSetup(url,config)` (negotiate to setup), `toPlaying(...)`, `fillHome(...)`.
- `s1_config.js` … `s9_fog_adversarial.js` — one script per scenario.

A few move-generation checks import the real engine `src/chaos.js` **read-only** (never
mutated) to assert authoritative geometry that is impractical to arrange over sockets
(sliders blocked by/​capturing enemies mid-board). The server's own move path
(`makeMoveChaos -> chaos.applyMove`) was independently verified to return the SAME sets via
`requestMoves` parity (scenario 4B), so engine-level and server-level results agree.

Run command (per script): `node sN_*.js` from the scratchpad. Full sweep output below.

---

## Scenario 1 — CONFIG NEGOTIATION — PASS (41/41) — `s1_config.js`

- 1a: both connect -> `state.phase==="config"` for both; `config` broadcast arrives; default
  config is the **classic preset**, `valid:true`, `agreed:{false,false}`; state carries
  additive `mode`/`boardDims`/`config`/`configVersion`.
- 1b: classic quick-path — one `agreeConfig` leaves phase `config` with `agreed.white=true`;
  both agree the current version -> `setup` with the standard **16-piece** roster, homeRanks
  `[1,2]`/`[7,8]`.
- 1c: agreement reset — W `proposeConfig(chaos)` bumps `version` and resets both agrees; B
  agrees (black=true); W edits again -> version bumps again, agrees reset, stays in `config`
  (does NOT start).
- 1d: **stale agree** — B `agreeConfig` with an OLD version is ignored (black stays false) and
  the server re-broadcasts `config` to the sender; then both agree the CURRENT version ->
  `setup`.
- 1e: validation errors surface as `config {valid:false, error}` and DO NOT start; agrees
  reset after an invalid both-agree; cannot leave `config` while invalid; recovers to `setup`
  once a valid config is agreed. Covered: **(a)** 0 kings (`error` mentions "king"), **(b)**
  huge roster on 8x8 (`error` "too large"), **(c)** banning the king type (`error` mentions
  "king").

## Scenario 2 — CHAOS SETUP + BOARD DIMS — PASS (36/36) — `s2_setup_dims.js`

For each of `8x8`, `10x8`, `10x10`: reaches `setup`; `state.boardDims` correct; `state.board`
has EXACTLY `cols*rows` keys; `state.setup` block present with `roster`, `boardDims`,
`homeRanks`, `promotionTypes`; W/B home regions are non-overlapping with Black on the high
ranks; valid arrangements (multiset == roster, within homeRanks) reach `playing` with a
`cols*rows`-key board. Invalid arrangements rejected: **wrong counts** (dropped a pawn) and
**out-of-home square** both produce `arrangementRejected`; a valid submit still works after.

## Scenario 3 — FOG LEAK AUDIT (HIGHEST PRIORITY) — PASS (18/18) — `s3_fogleak.js`

Played full chaos games **including fairy pieces** on 8x8, 10x8, 10x10 (roster:
`k,q,a,i,c,h,m,w,n,p×3`). Each game driven to completion (all ended by `kingCaptured`;
plies 29/11/11). For BOTH W and B streams, scanned every `state`, `moveMade`, `legalMoves`,
and `capture` payload:
- Every `state.board` had exactly `cols*rows` keys; every opponent square was **exactly**
  `{occupied:true}` (no `type`/`color`/extra keys); own cells `{type,color}` with
  `color===viewer` and a valid catalog type (fairy letters allowed for own).
- Deep recursive scan of each `state` (incl. `moveLog`) and each `moveMade.entry`
  (excluding the intentionally-revealed `capturedType`) found **no** object exposing an
  opponent `{type,color}`.
- `moveMade` opponent entries never carry `piece`/`san` (fairy identity never leaks via the
  log; opponent text stays `"unknown piece: …"`).
- Confirmed both viewers actually observed opponent pieces as `{occupied:true}` during play.

Key audit snippet (`lib2.auditFilteredBoard`):
```js
if (hasOcc) {
  if (hasType || hasColor) leaks.push(`LEAK ${ctx}: opponent ${sq} carries type/color`);
  const extra = Object.keys(cell).filter(k => k !== 'occupied');
  if (extra.length) leaks.push(`LEAK ${ctx}: opponent ${sq} extra keys`);
}
```
**Result: no leaks on any size with fairy pieces.**

## Scenario 4 — CHAOS MOVE CORRECTNESS — PASS (47/47) — `s4_moves.js`

Part A (authoritative engine geometry, `chaos.movesFrom` on crafted boards):
- Knight d4 = 8 leaps; ignores intervening pieces; cannot land on friendly; captures enemy.
- Bishop d4 = 13; **cannot pass friendly** (e5 in, f6/g7 out); **stops at & captures first
  enemy** (e5,f6 in, g7 out). Rook d4 = 14 with the same block/capture semantics.
- Queen d4 = 27. **Amazon d4 = 35** (queen 27 + knight 8); boxed by a friendly ring -> only
  the 8 knight leaps remain (leaps ignore blockers).
- **Nightrider d4 = 12** and **rides multiple hops** (f8 and b8 are two-hop rides; first-hop
  e6/h6 present); blocked by a friendly on the ride path (e6 friendly removes e6 AND f8);
  stops at first enemy on the path (e6 enemy in, f8 out).
- Camel = 8 (3,1 leaps); Chancellor = 22 (rook+knight); Archbishop = 21 (bishop+knight).

Part B (server parity + mechanics, real sockets):
- `requestMoves` for knight/amazon/nightrider/queen/bishop returns sets **identical** to
  `chaos.movesFrom` on the reconstructed true board.
- Amazon d1 slides up an open file and **captures the first enemy on d8** (does not pass it),
  and is blocked immediately by the friendly king/bishop on e1/c1.
- `requestMoves` on an opponent square returns `{hasMoves:false, moves:[]}`.
- Legal `makeMove` flips the turn and emits `moveMade` to both, with **no** `check` event.
- Illegal moves (out-of-turn, illegal geometry) return `errorMsg` and DO NOT change the turn.
- Across the whole chaos game: **no `check` event ever**, `state.inCheck` always `false`,
  `state.checkSquare` always `null`.

## Scenario 5 — KING CAPTURE + DRAW + MULTI-KING — PASS (31/31) — `s5_king_draw.js`

- Part A (engine `applyMove`, the exact path `server.makeMoveChaos` delegates to): a black
  king boxed at a1 by its own immobile pawns has 0 legal moves; after a white spare move the
  engine reports `{result:"stalemate", winner:null, reason:"stalemate"}`. Negative control:
  a lone mobile king is NOT a stalemate.
- Part B (server, single king): white Amazon captures Black's only king ->
  `capture {square:"d7", capturedType:"k", capturedColor:"b"}` then
  `gameOver {result:"kingCaptured", winner:"w", reason:"kingCaptured", fen:null}` with a
  64-key `fullBoard` revealing **both** colors' types; `state.phase==="ended"`,
  `state.result` = `kingCaptured/w`; both clients received `gameOver`.
- Part C (server, 2 kings): capturing ONE king emits the capture but **no** `gameOver` and the
  game stays `playing` (turn passes); after a harmless black reply, capturing the LAST king
  ends the game with `kingCaptured/w`.

> Note on the server-level DRAW: a self-contained stalemate box must sit on the board edge
> FAR from the owner's home region, so it cannot be built directly via a legal `setup`
> arrangement (which restricts pieces to the home ranks). It is instead verified
> authoritatively at the engine `applyMove` level — the identical code the server's chaos
> move handler calls — so the server draw branch is covered transitively.

## Scenario 6 — CHAOS PAWN + PROMOTION (incl. FAIRY) — PASS (32/32) — `s6_pawn_promo.js`

- Part A (engine): white pawn e2 -> `{e3,e4}` (double from rank 2); e3 -> `{e4}` only;
  diagonal captures onto enemies d3/f3 only (never onto empty/friendly); forward blocked ->
  no forward/double; black pawn d7 -> `{d6,d5}` (double from `rows-1`); a back-rank pawn
  (d8) gets only the single step; **no en passant** (white e5 beside a black pawn on d5
  cannot go d6); promotion flag set only on the far rank. `promotionTypes({k,p,a})==["a"]`;
  default and explicit promotion resolve to `a`.
- Part B (server): raced a white pawn b2->b4(double)->…->b7, then **`makeMove {promotion:"a"}`**
  to promote on b8. Confirmed the server offered the double-step and the `promotion:true`
  flag; after promotion **the OWNER's board shows `b8={type:"a",color:"w"}` while the
  OPPONENT's board shows `b8={occupied:true}` with no `type`** — fairy promotion does not
  leak. Own `moveMade.entry` carries `promotion:"a", piece:"p"`; opponent entry stays
  anonymized (no `piece`/`san`/promotion identity).

## Scenario 7 — CLASSIC REGRESSION — PASS (36/36) — `s7_classic.js`

Full classic games via the new flow (both agree the forced classic preset):
- Additive-only fields: `state.mode==="classic"`, `boardDims:{8,8}`, 64-key board, all v1
  fields intact; `legalMoves` shape unchanged (`{to,promotion}`).
- Legal/illegal: `1.e4` yields a `moveMade` with `piece:"p"` + a real `san`; opponent entry
  anonymized; out-of-turn and illegal-geometry moves return `errorMsg` with no turn change.
- **Capture reveal + check WITH checkSquare**: `4.Qxe5+` emits
  `capture {capturedType:"p", capturedColor:"b", square:"e5"}` and a `check` event to Black
  only (`{inCheck:true, checkSquare:"e5"}`); Black's `state.inCheck` true, White's false;
  game continues; Black blocks and check clears.
- **Resign** -> `gameOver {result:"resign", winner:"b", reason:"resign"}` with a **real
  `fen`** (castling field `-`, v1 invariant) and a 64-key `fullBoard` revealing both kings.
- **Checkmate** (scholar's mate `Qxf7#`): capture reveal + `check` event with `checkSquare:"f7"`
  + `gameOver {result:"checkmate", winner:"w", reason:"checkmate"}` with a real `fen`.

## Scenario 8 — REMATCH -> CONFIG — PASS (16/16) — `s8_rematch.js`

After a chaos game ends: first `rematch` emits `rematchPending {by:"w"}` and stays `ended`;
after both `rematch`, phase returns to **`config` (NOT `setup`)** with **colors retained**
(W=w, B=b), a fresh `config` broadcast, agreements reset to false, `configVersion` bumped,
the last agreed config retained for prefill, board reset to all-null, `result` cleared.
Renegotiation then reaches `setup` again.

## Scenario 9 — ADVERSARIAL FOG PROBE — PASS (8/8) — `s9_fog_adversarial.js`

10x10 with ALL six fairy types, played to game over. Deep-scanned EVERY non-`gameOver`,
non-`capture` event of BOTH viewers: **no** object anywhere exposes an opponent `{type,color}`.
Confirmed rank-10 squares (`a10`/`j10`) are present in state boards and never leak, opponents
were seen as `{occupied:true}`, and `gameOver.fullBoard` (100 keys incl. `j10`) IS the ONLY
place opponent types are revealed.

---

## Full sweep output (all scripts, back-to-back)
```
S1 CONFIG              41/41
S2 SETUP+DIMS          36/36
S3 FOG LEAK            18/18   (FOG NEVER LEAKED on 8x8/10x8/10x10 WITH fairy pieces)
S4 MOVE CORRECTNESS    47/47
S5 KING CAP + DRAW     31/31
S6 PAWN + PROMOTION    32/32
S7 CLASSIC REGRESSION  36/36
S8 REMATCH             16/16
S9 ADVERSARIAL FOG      8/8
TOTAL                 265/265
```

## Notes / non-issues
- Two initial FAIL lines during development were **my own arithmetic in expected slider
  counts** (bishop-with-blocker), not engine defects — the engine's positional behavior
  (which squares are in/out) was correct; I corrected the expected numbers. No app change.
- `state.config.roster` is present during `playing`; this is the SHARED, mutually-agreed
  roster (public house rules), not opponent placement — not a fog leak.
- No lingering server processes after the run (verified on ports 3141–3220). App source left
  untouched; all artifacts are in the scratchpad.

## FAILURES
None.
