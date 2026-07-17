# Agent 3 — Frontend Builder transcript

Scope: the browser client for Fog Chess. Built strictly to `CONTRACT.md`
(binding) with `PLAN.md` for context. No build step, no frameworks, no external
CDNs. Socket.io client is loaded from the server-hosted path
`/socket.io/socket.io.js`.

## Files created (my ownership only)

- `public/index.html` — single page with five `<section>` screens toggled by a
  `data-screen` attribute on `<body>` (`lobby`, `rejected`, `setup`, `game`,
  `end`), plus a toast element and two modals (promotion, pin). Loads
  `style.css`, then `/socket.io/socket.io.js`, then `client.js`. I did not touch
  `server.js`, `package.json`, or anything under `src/`.
- `public/style.css` — dark theme, CSS-grid 8x8 board, setup tray, pins,
  banners, modals, toast. Board is `display:grid` (no canvas, no table).
- `public/client.js` — all socket handling, rendering, drag/drop setup, legal
  move UI, promotion, pins. Plain IIFE, ES5-ish, no dependencies.

Verification performed: `node --check public/client.js` passes; every
`$("id")` reference cross-checked against an `id=` in the HTML (no missing IDs);
socket event names enumerated and matched against the contract table.

## Screens / phases (all driven off `state.phase` + `state.yourColor`)

The `state` event is treated as authoritative for phase. `assigned` and
`waiting` are convenience signals only.

1. **lobby** — spinner + "Waiting for opponent to connect". Text updated from
   `waiting.message` and from `state` (opponentConnected).
2. **rejected** — shown on the `rejected` event ("Match is full…"). Dead-ends.
3. **setup** — renders ONLY the player's own two home ranks as a 2x8 grid,
   oriented with the player's back rank at the bottom (White ranks 2 over 1;
   Black ranks 7 over 8 with files reversed, i.e. a 180° board). A tray shows
   remaining pieces (8p 2r 2n 2b 1q 1k) with live counts. HTML5 drag/drop:
   tray→square places, square→square moves/swaps, square→tray (or click a placed
   piece) removes. "Standard setup" and "Clear" helpers included. "Ready" is
   enabled only at exactly 16 placed and emits `submitArrangement {placement}`.
   `arrangementAccepted` shows "waiting for opponent to be ready";
   `arrangementRejected` shows the server reason and re-enables Ready.
4. **game** — full 8x8 board oriented player-at-bottom, turn indicator
   (`state.yourTurn`), check banner, move log panel, Resign button, pin legend.
5. **end** — full reveal from `gameOver.fullBoard` (both colors real types),
   result/winner/reason line (+ FEN), final move log, Rematch button,
   rematchPending status line.

## Board orientation

`orderedSquares(color)` returns the 64 (or 16 for setup) squares in display
order top-left→bottom-right. White: ranks 8→1, files a→h. Black: ranks 1→8,
files h→a. Both boards and the setup grid reuse this so the player's side is
always at the bottom.

## Fog enforcement (client-side)

`renderBoard` has three mutually exclusive cell branches when not revealing:
- own piece (`cell.type` present) → real Unicode glyph in the piece's color;
- opponent (`cell.occupied === true`) → a grey radial-gradient disc that renders
  a "?" via CSS (`.unknown::after`), NEVER a glyph, NEVER a type;
- `null` → empty.
The only place real opponent types are drawn is the `end` screen, rendered from
`gameOver.fullBoard` with `revealed=true`. The client never infers or stores an
opponent type anywhere. `capturedType` from the `capture` event is shown only as
a toast/log text, not placed on the board.

## Pins (client-side only, never emitted)

- `pins` is an in-memory object `{ square: guessLabel }`. Nothing about pins is
  ever passed to `socket.emit`.
- Clicking an occupied OPPONENT square opens a modal offering Pawn/Knight/
  Bishop/Rook/Queen/King buttons plus a free-text input. Saved pins render as a
  small purple `.pinTag` overlay (single letter for the 6 known types, else the
  raw text) in the top-left of that square, and are listed in the side panel.
- Manual re-pin (reopen picker) and clear (Clear pin button) supported.
- **Auto-fade:** `reconcilePins(newBoard)` runs on every `state` carrying a
  board; for each pinned square, if the new board cell is no longer
  `{occupied:true}` (became `null` or the viewer's own piece), the pin is
  deleted (with a brief `.fade` CSS class applied to any on-screen tag). Pins
  are also fully cleared on a new setup/rematch via `resetForNewGame`.

## Promotion

`legalMoves` entries are `{to, promotion:bool}`. When the clicked destination has
`promotion:true`, the promotion modal opens and the move is held in
`promoPending`; choosing Q/R/B/N emits `makeMove {from,to,promotion:<letter>}`.
Non-promotion moves emit with `promotion:null`.

## Move / capture / check handling

- Move log is rendered from `state.moveLog` (the authoritative, per-viewer,
  already-anonymized list) so own moves show full text and opponent moves show
  `"unknown piece: e7->e5"` exactly as sent. Capture lines (which include the
  `(captured X)` suffix from the server) get a highlight class.
- `moveMade` is used only to set `lastMove` and a `pendingFlash`; after the next
  `state` re-renders the board, both from/to squares get a persistent
  `.lastmove` highlight and a one-shot `.flash` animation. (I deliberately do
  NOT append the log from `moveMade` to avoid duplicating `state.moveLog`; the
  entry.text is still surfaced because `state.moveLog` contains the same entry.)
- `check` shows the "You are in check!" banner and outlines `checkSquare`;
  `state.inCheck`/`checkSquare` keep it consistent and clear it when resolved.
- `capture` shows a toast "Captured <Type> (your/opponent's) on <square>".

## Socket events (cross-checked against CONTRACT.md)

Emitted (client→server) — exactly the 5 contract events:
`submitArrangement {placement}`, `requestMoves {square}`,
`makeMove {from,to,promotion}`, `resign {}`, `rematch {}`.

Listened (server→client): `assigned`, `rejected`, `waiting`,
`arrangementAccepted`, `arrangementRejected`, `gameStart`, `legalMoves`,
`moveMade`, `errorMsg`, `check`, `capture`, `state`, `gameOver`,
`rematchPending` (plus socket.io `connect`/`disconnect`). Every payload field I
read matches the contract (`assigned.color/role`, `rejected.reason`,
`waiting.message`, `arrangementRejected.reason`, `legalMoves.square/moves/
hasMoves`, `moveMade.entry/from/to`, `errorMsg.message`, `check.inCheck/
checkSquare`, `capture.square/capturedType/capturedColor`, full `state`,
`gameOver.result/winner/reason/fullBoard/fen`, `rematchPending.by`).

`gameStart` is intentionally a no-op (the playing `state` that follows is
authoritative).

## Assumptions

- Server sends a `state` after connect; the client relies on it for phase. The
  lobby screen is shown until then.
- `state.moveLog` is the complete per-viewer log on every snapshot (contract
  Section 6 shows it as the full array), so rendering it fresh each time yields
  the whole log without needing to accumulate `moveMade` entries.
- On the `ended` phase I prefer `gameOver.fullBoard` for the reveal. If (only)
  an `ended` `state` arrives without a preceding `gameOver`, I fall back to
  rendering the filtered `state.board` — which still never leaks opponent types.
- Setup swap semantics: dropping a placed piece onto another occupied home
  square swaps them; dropping a tray piece onto an occupied square replaces it
  (old piece returns to tray).

## Risks / notes for test agents

- I could not run the real backend (built in parallel), so socket interop is
  verified only against the contract by inspection, not end-to-end. Watch for
  any field-name drift on the backend side.
- Castling is assumed absent (contract invariant 6); no castling UI exists. En
  passant just appears as a normal pawn capture (server-driven), fine.
- Back-rank pawns: no special client handling; the server governs legality and
  the setup UI notes the "no double-step from back rank" behavior as intended.
- The `.flash` move animation depends on `moveMade` arriving before `state`
  (contract Section 4 emit order). The persistent `.lastmove` highlight does not
  depend on that ordering.
- Pin auto-fade depends on the opponent cell changing from `{occupied:true}` in
  the post-move `state`; a piece that moves away and whose square is refilled by
  another opponent piece in the same turn (not possible in standard chess) would
  keep the stale pin — not a real scenario here.
- No reconnect handling (out of scope). A `disconnect` just shows a toast.
