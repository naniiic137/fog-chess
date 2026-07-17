# Agent 1 (Planner) - Transcript

Role: Planning agent (1 of 5) for the Fog Chess LAN chess variant. Read-only
except for producing the planning/contract markdown deliverables. Wrote no
application code.

## What I analyzed
- Read the working directory. It contained only `fog-chess-build-prompt.md`
  (the original product spec); not a git repo; Node v22.14.0, npm 11.13.0.
- Read `fog-chess-build-prompt.md` in full to understand the product: 2-player
  real-time LAN chess, secret custom setup, fog-of-war view filtering, private
  pins, capture/check reveal defaults, rematch.
- Reconciled the original spec with the LOCKED design decisions in my task, which
  override parts of the original spec:
  - Castling is DROPPED in v1 (original spec mentioned Chess960 castling; task
    overrides -> no castling, FEN castling field always `-`).
  - Pawns get full placement freedom including their own back rank; FEN must be
    loaded with `skipValidation:true`.
  - Fog is strictly a per-client emit-time view filter; the engine stays standard
    and full-information; never emit the raw board.
- Verified the chess.js API against the current published version: `npm view
  chess.js version` -> `1.4.0`. Confirmed 1.4.0 supports `load(fen,{skipValidation})`,
  `moves({square,verbose})`, `attackers(square,color)`, `isCheck/isCheckmate/
  isStalemate/isDraw/isGameOver`, `board()`, `get()`, `turn()`, `fen()`. These
  underpin the plan (legal-move highlighting, check-square detection, end detection).

## Key decisions and rationale
1. **Single authoritative `state` event, emitted per-viewer.** Every state change
   ends with a per-color `state` broadcast carrying that color filtered board +
   filtered move log + its own check info. This makes the client a pure renderer
   and makes the "never leak opponent types" invariant enforceable in one place.
2. **Fog isolated to `src/fog.js`** with three pure functions (filterBoard,
   revealBoard, filterMoveRecord) + checkInfoFor. Keeps hidden-info logic out of
   the rules engine, matching the core principle.
3. **Filtered board shape = 64-key object** of `{type,color} | {occupied:true} |
   null`. Chose a full 64-key map (not a sparse map or array) so the frontend can
   render deterministically and diff for pin auto-fade without ambiguity.
4. **Arrangement payload = `{square: pieceType}` with color implied by sender.**
   Server applies color when building FEN and validates counts + home-rank
   membership + square format. Prevents a client from smuggling pieces onto
   illegal squares or claiming the wrong color.
5. **`submitArrangement` doubles as Ready.** One event locks + marks ready; on
   both-ready the server builds the FEN and starts. Simpler contract, fewer
   round-trips, matches the "Ready button locks it" spec.
6. **Move flow ordering fixed** (moveMade -> capture -> check -> state ->
   gameOver) so frontend animation/log/banners have deterministic sequencing.
7. **Promotion:** client sends `promotion` for last-rank pawn moves; server
   defaults to `q` if omitted. legalMoves collapses multi-piece promotion to one
   destination with `promotion:true` so the UI shows a single target then a picker.
8. **Check reveal:** server computes the checking piece square via
   `chess.attackers(kingSquare, opponentColor)` and sends only the square. Fallback
   documented if a chess.js build lacks `attackers`.
9. **Pins are 100% client-side** and appear in NO socket event. Documented
   auto-fade rule (compare pinned squares against the new filtered board each
   `state`). This removes any backend/frontend coupling on pins.
10. **File ownership split** to let the two builders work in parallel with zero
    collisions: backend owns `package.json`, `server.js`, `src/**`; frontend owns
    `public/**`. Their only shared dependency is `CONTRACT.md`.
11. **Contract precedence rule:** if PLAN.md and CONTRACT.md ever disagree on a
    payload, CONTRACT.md wins. Stated in both files.

## Files I created
- `PLAN.md` - full implementation plan: structure + ownership, game state model,
  phase state machine, fog filter spec, arrangement->FEN construction, back-rank
  pawn edge case, legal-move highlighting, client-side pins, server wiring,
  frontend structure, build order, risks.
- `CONTRACT.md` - the binding Socket.io event contract: shared types (square,
  color, piece, filtered board cell, filtered board, full board, arrangement,
  move log entry, move destination), every event with direction + concrete
  example JSON, an event summary table, and invariants.
- `transcripts/agent1-planner.md` - this transcript.

I did NOT create any application code (no server.js, no client.js, no src/*, no
public/*). Those are for the backend and frontend build agents.

## Socket events defined (contract)
Client -> Server: `submitArrangement`, `requestMoves`, `makeMove`, `resign`,
`rematch`.
Server -> Client: `assigned`, `rejected`, `waiting`, `arrangementAccepted`,
`arrangementRejected`, `gameStart`, `legalMoves`, `moveMade`, `errorMsg`,
`check`, `capture`, `state`, `gameOver`, `rematchPending`.

## Risks / notes handed to builders and testers
- **Leak risk (top priority for testers):** verify no `state.board` or
  `moveMade.entry` ever contains an opponent piece `type`; only `gameOver.fullBoard`
  reveals opponent types. Also verify `capture.capturedType` only fires when
  reveal flag is on.
- **`attackers` dependency:** relies on chess.js `attackers()` (in 1.4.0). If the
  installed version differs, use the documented fallback (scan opponent verbose
  moves targeting the king square).
- **Back-rank pawns:** intentionally get no double-step (chess.js only double-steps
  from rank 2/7). This is accepted v1 behavior; do not "fix" it. Frontend should
  note it in the setup UI.
- **Per-viewer emits:** `state`/`moveMade`/`check` must be emitted separately to
  each color; a single shared `io.emit` of the board would leak info and is wrong.
- **Promotion picker:** frontend must present q/r/b/n when a legalMoves entry has
  `promotion:true`; server defaults to `q` if the client omits it.
- **Disconnect handling is intentionally minimal** (reconnect out of scope). The
  only requirement is not leaving the remaining client stuck (emit an
  `opponentLeft` result). Do not over-build.
- **One match only, in-memory:** no rooms, no DB, no accounts, no HTTPS. Third+
  connections get `rejected {reason:"full"}`.
