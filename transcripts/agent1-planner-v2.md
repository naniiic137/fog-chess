# Agent 1 (Planner) - v2 Transcript

Role: Planning agent (1 of 5) for the Fog Chess v2 feature set. Read-only; produced
only markdown planning/contract deliverables. Wrote no application code.

## What I analyzed
- Read the full v1 project to extend rather than fight it: `README.md`,
  `CONTRACT.md`, `PLAN.md`, `server.js`, `src/game.js`, `src/fen.js`, `src/fog.js`,
  `public/index.html`, `public/style.css`, `public/client.js`, `package.json`.
- Confirmed the v1 invariant is centralized in `src/fog.js` (filterBoard /
  revealBoard / filterMoveRecord / checkInfoFor) and that `server.js` already emits
  per-viewer `state`/`moveMade`/`check`. This is the seam v2 extends.
- Noted v1 hard-codes 64 squares in three places (`fog.js` ALL_SQUARES, `fen.js`
  rank loop, `client.js` FILES/RANKS) and orientation logic in `client.js`
  `orderedSquares` — the main surfaces that must generalize for variable boards.
- Confirmed classic uses chess.js `^1.4.0` with `skipValidation` FEN loading and
  that no v1 behavior should change from `setup` onward.

## Key design decisions and rationale
1. **Mode split by routing, not rewrite.** `game.js` routes to the untouched
   classic path (chess.js) or the new `src/chaos.js`. Classic stays the default and
   backward-compatible; chaos is fully isolated. Lowest-risk way to add a second
   engine.
2. **Two-primitive movement descriptor (`leaps` + `slides`).** Every piece is
   uniform data. Riders (Nightrider) are just slides with a knight vector — so the
   engine has exactly two loops and no special rider path. This makes standard AND
   fairy pieces trivially expressible and keeps move-gen tiny and auditable. Chose
   to unify `rides` into `slides` to avoid a third code path.
3. **King-capture, no check.** Chaos legality = on-board + descriptor + not-friendly;
   pseudo-legal == legal. Win when opponent royals hit 0; draw when the side to move
   has no legal moves. Removing check/self-check makes the engine dramatically
   simpler and matches the approved rules. Kings are ordinary `royal:true` pieces,
   so multiple kings and multi-king capture fall out naturally.
4. **Coordinate scheme = single-letter file + decimal rank, parsed
   `^([a-z])([0-9]{1,2})$`.** Since cols <= 10 <= 26, the file is always one letter,
   so `a10` is unambiguous (file a, rank 10). Every board object is keyed by
   `allSquares(dims)` (cols*rows), never 64. Classic is the 8x8 special case, so its
   squares stay `a1..h8`. Explicitly banned `sq[1]`-style rank parsing (breaks at
   rank 10) — called out as a builder trap.
5. **Pawn double-step by current rank, not per-pawn origin.** Double-step allowed
   only from the color's second rank (White rank 2, Black rank `rows-1`), height-
   aware and stateless. Mirrors the v1 back-rank-pawn behavior without tracking
   origins. No en passant in chaos. Promotion targets = roster non-royal, non-pawn
   types (fairy allowed).
6. **Shared symmetric roster + home-region math.** Both armies identical (one
   `roster` in config). `N = max(2, ceil(total/cols))` home ranks per side; require
   `2N <= rows` so regions never overlap; invalid configs are blocked at agree time.
   Keeps setup and validation simple and symmetric.
7. **Config/negotiation phase with version-nonce agreement reset.** New
   `phase:"config"` between lobby and setup. `proposeConfig` replaces config,
   bumps `configVersion`, and clears both agrees. `agreeConfig{version}` only counts
   if it matches the current version; both-agree + valid -> setup. Any edit after an
   agree resets agreement for both — so the final identical config is always
   double-agreed. The version nonce cleanly rejects stale agrees from a client that
   agreed to an already-edited proposal.
8. **Classic still works via a trivial negotiation.** Default config is the Classic
   preset; classic players just both-press Agree. Rematch returns to `config` (not
   setup) so house rules can be renegotiated each match; classic just re-agrees.
9. **Fog generalized, not relocated.** `fog.js` stays the ONLY hidden-info module.
   It gains a board-source abstraction (`get(sq)`) so it can filter both a chess.js
   instance (classic) and a chaos board map without importing chaos rules, plus
   `allSquares(dims)` and fairy names. Opponent fairy pieces remain `{occupied:true}`
   — identical neutral token — so the leak invariant is byte-for-byte unchanged.
10. **File-ownership split preserved.** Backend owns `server.js` + `src/**` (incl.
    new `src/chaos.js`); frontend owns `public/**`. Only coupling = `CONTRACT-v2.md`.

## Fairy roster chosen (wild / long-distance)
Amazon `a` (Q+N), Chancellor `c` (R+N), Archbishop `h` (B+N), Nightrider `i`
(knight-vector rider), Camel `m` ((3,1) leaper), Wizard `w` (Camel+Ferz). Letters
never collide with `p r n b q k`. Own fairy pieces render as `A C H I M W` badges;
opponent fairy pieces render the neutral hidden token.

## Files I authored (delivered as text for saving; I have no write access)
- `PLAN-v2.md` - full v2 plan: mode split, chaos engine (descriptors + move-gen +
  king-capture/draw + pawns), coordinate/board-dims system, config/negotiation
  state machine with agreement reset, home-region computation, fog generalization,
  build order, file-ownership split, risks.
- `CONTRACT-v2.md` - v2 socket contract extending v1: `proposeConfig`/`agreeConfig`/
  `config` events, additive `state` fields (`mode`, `boardDims`, `config`, `agreed`,
  `configVersion`, `setup` block), generalized board objects, `kingCaptured`
  gameOver, movement-descriptor JSON + full piece catalog as shared reference data.
- `transcripts/agent1-planner-v2.md` - this transcript.

I created NO application code. `src/chaos.js` and all edits are for the builders.

## Risks / notes handed to builders and testers
- **PRIORITY #1 - fog leak with variable boards + fairy pieces.** Extend the v1
  automated leak audit to chaos, fairy rosters, and 10x10: assert no `state.board`
  or `moveMade.entry` ever carries an opponent `type` (standard or fairy), every
  board has exactly `cols*rows` keys, and only `gameOver.fullBoard` reveals types.
- **PRIORITY #2 - classic backward-compat.** From `setup` onward, classic must be
  byte-for-byte v1 (chess.js, real FEN, 64 keys, castling `-`, check/checkmate/en
  passant/promotion). Do not refactor the classic path; only route to it.
  Regression-test a full classic game + resign + rematch.
- No check in chaos: `inCheck` always false, no `check` event; win only via
  `kingCaptured`; draw only when the side to move has zero legal moves.
- Square parsing must use `^([a-z])([0-9]{1,2})$` everywhere (rank 10 trap).
- Reject configs with `roster.k < 1` or `2*N > rows`; surface the error in the
  config screen; never enter setup with an impossible roster/board.
- Agreement reset: any `proposeConfig` bumps the version and clears both agrees;
  ignore stale `agreeConfig` (version mismatch).
- Promotion in chaos may be a fairy letter; validate against roster promotion
  options.
- Contract precedence: if PLAN-v2 and CONTRACT-v2 differ, CONTRACT-v2 wins.