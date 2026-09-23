# Agent 5 — Frontend / End-to-End Integration Test transcript

Tester: TEST AGENT B (frontend + E2E). Method: full static/protocol review of
`public/index.html`, `public/style.css`, `public/client.js`, cross-checked against
`CONTRACT.md`, plus a live end-to-end run driving the real backend on a dedicated
port (`PORT=3200`) with two `socket.io-client` sockets through
setup → playing → checkmate. No project source files were modified.

Overall verdict: **PASS** (with one LOW/MEDIUM latent bug; no fog leak, no contract break).

---

## 1. Asset serving (server on PORT=3200) — PASS

| Path | HTTP | Content-Type | Bytes |
|------|------|--------------|-------|
| `/` | 200 | text/html; charset=UTF-8 | 5587 |
| `/index.html` | 200 | text/html; charset=UTF-8 | 5587 |
| `/style.css` | 200 | text/css; charset=UTF-8 | 9502 |
| `/client.js` | 200 | application/javascript; charset=UTF-8 | 23034 |
| `/socket.io/socket.io.js` | 200 | application/javascript; charset=utf-8 | 155836 |

- `index.html` references `style.css` (relative), `/socket.io/socket.io.js`
  (absolute server path), and `client.js` (relative) — all resolve to 200.
- `node --check public/client.js` → **SYNTAX_OK**.
- Every `$("id")` reference in client.js maps to an `id=` in index.html
  (30 referenced IDs, all present; 0 missing). No dangling element references.
- Note: index.html has no explicit `<html>/<head>/<body>` tags. This is benign —
  the browser auto-creates `document.body`, which `setScreen()` relies on
  (`document.body.setAttribute("data-screen", …)`), and the served
  `Content-Type` is `text/html`. Works.

---

## 2. Contract conformance — client side

### Emits (client → server) — all EXACT

| Event | client.js | Payload sent | Contract | OK |
|-------|-----------|--------------|----------|----|
| `submitArrangement` | :609 | `{placement: {sq:type}}` (16 enforced) | `{placement}` | ✅ |
| `requestMoves` | :334 | `{square: s}` | `{square}` | ✅ |
| `makeMove` | :346 | `{from, to, promotion}` | `{from,to,promotion?}` | ✅ |
| `resign` | :617 | `{}` | `{}` | ✅ |
| `rematch` | :621 | `{}` | `{}` | ✅ |

- Exactly the 5 contract emits, no extras. Pins are **never** emitted (verified:
  no `socket.emit` references `pins` anywhere).
- `submitArrangement` shape validated live: `{placement:{"a1":"r",...}}` accepted
  by backend, transitioned to `playing`.
- 16-piece / home-rank / correct-multiset constraints are enforced client-side:
  Ready is disabled unless exactly 16 placed (`updateReady` :207-211), drops are
  rejected off home ranks (`onDropToSquare` :177), and the tray caps each type at
  `FULL_COUNTS`, so the only way to reach 16 placed is the exact standard
  multiset (8p/2r/2n/2b/1q/1k). Server also revalidates.

### Listeners (server → client) — field names verified

| Event | Fields read (client.js) | Contract fields | OK |
|-------|-------------------------|-----------------|----|
| `assigned` | `d.color`, `d.role` :457-459 | `{color, role}` | ✅ |
| `rejected` | `d.reason` :466 | `{reason}` | ✅ |
| `waiting` | `d.message` :471 | `{message}` | ✅ |
| `arrangementAccepted` | (none needed) :474 | `{ok}` | ✅ |
| `arrangementRejected` | `d.reason` :482 | `{reason}` | ✅ |
| `gameStart` | no-op :486 (state authoritative) | `{turn}` | ✅ (intentional) |
| `legalMoves` | `d.square`, `d.moves`, `d.hasMoves` :489-492 | `{square,moves,hasMoves}` | ✅ |
| `moveMade` | `d.from`, `d.to` :498 (entry from `state.moveLog`) | `{entry,from,to}` | ✅ |
| `errorMsg` | `d.message` :504 | `{message}` | ✅ |
| `check` | `d.inCheck`, `d.checkSquare` :507-508 | `{inCheck,checkSquare}` | ✅ |
| `capture` | `d.capturedColor`, `d.capturedType`, `d.square` :517-518 | `{square,capturedType,capturedColor}` | ✅ |
| `state` | `phase,yourColor,yourTurn,inCheck,checkSquare,board,moveLog,opponentConnected,yourReady,opponentReady,result` | Section 6 | ✅ |
| `gameOver` | `over.result,winner,reason,fullBoard,fen` :431-445 | `{result,winner,reason,fullBoard,fen}` | ✅ |
| `rematchPending` | `d.by` :573 | `{by}` | ✅ |

All 14 contract server→client events are handled; move-log entry fields
(`ply,color,from,to,own,capture,text`) and legalMoves `moves[].to/.promotion`
are read exactly as specified.

**Live E2E confirmation of payload shapes:**
- `assigned`: `{"color":"w","role":"white"}` / `{"color":"b","role":"black"}`.
- `legalMoves f2`: `{"square":"f2","moves":[{"to":"f3","promotion":false},{"to":"f4","promotion":false}],"hasMoves":true}` — matches `moveHintFor` expectations.
- `moveMade` own (W): full `entry` with `piece:"p", san:"f3", text:"Pawn f2->f3"`.
- `moveMade` opponent (B's view of same move): anonymized — no `piece`/`san`,
  `text:"unknown piece: f2->f3"`. Client only reads `from`/`to` from moveMade and
  renders the log from `state.moveLog`, so anonymization is respected.
- `check` (to checkmated W only): `{"inCheck":true,"checkSquare":"h4"}`; B never
  received a `check` event. Matches "checked player only".
- `gameOver`: keys `[result,winner,reason,fullBoard,fen]`, `fullBoard.h4 =
  {"type":"q","color":"b"}` (real type revealed only here).

---

## 3. FOG enforcement in the client — PASS (no leak)

Static review of `renderBoard` (:251-293) — three mutually-exclusive content
branches:
- `revealed === true` → real glyph (ONLY reached from `renderEnd` with
  `gameOver.fullBoard`).
- `!revealed && cellVal.type` → own piece glyph.
- `!revealed && cellVal.occupied` → `unknownMarker()` (grey disc, `?` via CSS
  `.unknown::after`). Never a glyph, never a type.

No code path renders an opponent glyph from `state.board`. `capturedType` from
the `capture` event is surfaced only as a toast (:518), never placed on the
board. Pins are the only overlay on opponent squares and carry the viewer's own
guess, not server info.

**Live fog check (W's filtered board during play):** 64 keys present;
own = 16, opponent (`{occupied:true}`) = 16, empty (`null`) = 32,
**type/color leaks on opponent cells = 0**. `e8` (opponent) = `{"occupied":true}`
exactly. Invariant #1 upheld end-to-end.

---

## 4. Phase / rendering logic — PASS

- Rendering driven off authoritative `state.phase` + `state.yourColor` (:531-565).
  `assigned`/`waiting` only update lobby text, never phase.
- Orientation: `orderedSquares(color)` puts each player's side at the bottom for
  BOTH colors (White ranks 8→1/files a→h; Black ranks 1→8/files h→a = 180°).
  Setup grid uses the same, filtered to home ranks, so the back rank sits at the
  bottom for both. Verified by logic; standard setup places back rank on rank 1
  (W) / rank 8 (B).
- Setup: only the 2 home ranks rendered + 16-piece tray with live counts; Ready
  enabled only at 16 placed; `arrangementRejected` shows reason and re-enables
  Ready. ✅
- Promotion: modal opens only for `moves[].promotion === true` targets, holds
  `promoPending`, emits `makeMove` with chosen letter (:626-634). ✅
- Move log: own = full text, opponent = anonymized text straight from
  `state.moveLog`; capture lines get `.cap` class. ✅
- Check: banner + `.checksq` outline on `state.checkSquare` (:235-243). ✅
- Resign: `confirm()` gate before emit (:616-618). ✅
- Rematch: emits `rematch {}`, shows waiting text; `rematchPending` distinguishes
  "you requested" vs "opponent wants rematch" by `d.by === yourColor` (:572-577). ✅
- End screen reveals both boards from `gameOver.fullBoard` with `revealed=true`. ✅
- `resetForNewGame` clears placement/pins/selection on entering a fresh setup
  (first game or post-rematch) (:591-602). ✅

---

## 5. Pins — PASS

- Click on an `{occupied:true}` square opens the pin modal (:325-328); guess
  stored in local `pins{}` and rendered as a `.pinTag` overlay distinct from the
  `?` marker (:283). Listed in side panel.
- Never emitted (confirmed — no socket reference).
- Auto-fade: `reconcilePins(newBoard)` runs on every `state` with a board
  (:410-421, called :527); drops any pin whose square is no longer
  `{occupied:true}` (became `null` or own piece), applying a `.fade` class to a
  live tag first. Cleared on rematch via `resetForNewGame`.

---

## 6. Robustness — PASS with one latent bug

- All 64 squares always rendered (`orderedSquares` iterates all 64; `board[s]`
  defaults to `null`).
- Tolerant of `state` in any phase (switch covers lobby/setup/playing/ended; no
  default-throw).
- `node --check` clean; no references to undefined element IDs; no reads of
  fields absent from the contract.

### BUG (LOW–MEDIUM, latent): `ended`-state fallback crashes on opponent cells
`public/client.js:560`
```js
if (state.result) renderEnd(Object.assign({ fullBoard: state.board }, state.result));
```
The `ended` branch has a fallback "if `gameOver` not yet received, render from the
filtered `state.board`". But it calls `renderEnd(...)` → `renderBoard(endBoard,
board, revealed=true)`, and the revealed branch (:275) does
`pieceSpan(cellVal.type, cellVal.color)`. For an opponent cell the filtered value
is `{occupied:true}` (no `type`/`color`), so `pieceSpan` runs
`GLYPH[undefined][undefined]` → **TypeError: Cannot read properties of undefined**
(reproduced directly). At any real game end there are opponent pieces on the
board, so the fallback throws.

**Why severity is not CRITICAL:** the live event order for the losing player is
`state(phase:ended)` → `gameOver` (confirmed E2E: `W state -> W gameOver`). The
throw aborts only the fallback block (so `setScreen("end")` on :562 is skipped),
then `gameOver` arrives immediately, `renderEnd(over)` runs with the real
`fullBoard`, and `setScreen("end")` (:569) fires — the end screen ultimately
renders correctly. Net observable effect: one uncaught `TypeError` in the console
during the transition, and the fallback itself is effectively non-functional
(it never renders anything on its own). It is NOT a fog leak (it crashes rather
than showing wrong data) and NOT a contract break. Resign/opponentLeft ends emit
`gameOver` BEFORE `state`, so the screen is already `"end"` and this branch is
skipped entirely — no crash there.

**Suggested fix:** in the fallback, render the filtered board with `revealed=false`
(so opponent cells draw the `?` marker), or guard the revealed branch in
`renderBoard` to fall through to `unknownMarker()` when `cellVal.type` is absent:
```js
if (revealed && cellVal.type) cell.appendChild(pieceSpan(cellVal.type, cellVal.color, false));
else if (revealed) cell.appendChild(unknownMarker());
```

---

## PASS/FAIL by area
| Area | Result |
|------|--------|
| Asset serving | PASS |
| Contract emits | PASS |
| Contract listeners | PASS |
| Fog enforcement (client) | PASS (0 leaks, static + live) |
| Phase/render logic | PASS |
| Pins | PASS |
| Robustness | PASS (1 latent LOW–MEDIUM bug) |

## Cleanup
- Stopped the PORT=3200 server started for this test. Project source untouched.
- Scratchpad artifacts (e2e.js, socket.io-client install) left in the session
  scratchpad only.
