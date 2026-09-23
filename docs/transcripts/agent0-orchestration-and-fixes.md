# Orchestration & Fixes — Fog Chess (lead)

5-agent pipeline run to build Fog Chess, plus the bug fixes applied afterward.

## Pipeline
| Agent | Role | Output | Verdict |
|-------|------|--------|---------|
| 1 | Planner | `PLAN.md`, `CONTRACT.md` (binding socket interface) | Contract complete & precise |
| 2 | Backend builder | `package.json`, `server.js`, `src/{game,fen,fog}.js` | Server starts clean, chess.js 1.4.0 |
| 3 | Frontend builder | `public/{index.html,style.css,client.js}` | 5 screens, no build step |
| 4 | Test A (backend/rules/fog) | drove real server w/ 2 socket clients, 6 games | PASS except 1 critical bug; **fog-leak audit PASSED (0 leaks)** |
| 5 | Test B (frontend/integration) | asset serving + static + live e2e | PASS; 1 low-med latent bug; **fog clean** |

## Locked design decisions (from user)
- Castling dropped in v1 (FEN castling field always `-`).
- Pawns may be placed anywhere on the 16 home squares incl. the back rank (loaded via chess.js `skipValidation`; back-rank pawns get no double-step — accepted).
- `revealCapturedPieceType: true`; check reveals the checking piece's square only.

## Bugs found by testers and fixed (lead)
### BUG 1 (CRITICAL) — rematch crashed the server
`src/game.js` had an instance field `this.rematch = {...}` that shadowed the
prototype method `rematch(color)`, so `server.js` calling `game.rematch(color)`
threw `TypeError: game.rematch is not a function`, an uncaught throw that killed
the process and ended the match for both players.
- Fix: renamed the method to `requestRematch(color)` in `src/game.js`; updated
  the call site `server.js` (`game.requestRematch(color)`). Field `this.rematch`
  kept as the state.

### BUG 2 (LOW–MED) — ended-state fog fallback
`public/client.js` `ended` fallback (used only if a `state:ended` arrives before
`gameOver`) rendered the *filtered* board with `revealed=true`, which hit the
reveal glyph path on opponent `{occupied:true}` cells → TypeError. Not a fog leak
(it crashed rather than showed wrong data) but a latent console error.
- Fix: fallback now renders with `revealed:false` (fog holds); `renderEnd` updated
  to honor a `revealed` flag and use `over.board` when `fullBoard` is absent. The
  real full reveal still comes from `gameOver.fullBoard`.

## Post-fix verification
`scratchpad/verify_rematch.js` drove a full game → resign → both rematch → fresh
game, against the live server:
```
gameStart received: true
gameOver after resign: resign winner=b
rematchPending after first request: { by: 'w' }
After both rematch -> W state.phase: setup | B state.phase: setup
Colors retained -> W.yourColor: w | B.yourColor: b
Second game started after rematch (server alive): true
RESULT: PASS
```
Server log showed no crash. `node --check` clean on client.js, server.js, game.js.

## How to run
`npm install` then `npm start`; open the printed LAN URL on two devices on the
same WiFi. First connection = White, second = Black.
