# Agent 5 — Frontend & E2E Integration Test (v2)

Scope: FRONTEND (`public/index.html`, `public/style.css`, `public/client.js`) + end-to-end
integration against `CONTRACT-v2.md`. No app source modified. Server driven on dedicated
port **3200** with socket.io-client harnesses (scratchpad). Static + protocol review plus
live payload dumps (no headless browser used/installed).

**Overall verdict: PASS.** Assets serve correctly, config negotiation works client-side,
the generalized board is correct for variable dims, and there are **zero fog leaks** on the
client side (verified on 8×8 classic, 8×8 chaos, and 10×10 chaos incl. fairy pieces).

---

## 1. Asset serving  — PASS

`node --check public/client.js` → CLEAN. CSS braces balanced (per builder; page renders).
Cross-check: all 48 distinct `$("id")` references in client.js exist in index.html
(**MISSING: NONE**); `querySelectorAll(".pinBtn")` resolves (6 buttons present).

| Path | HTTP | Content-Type | Bytes |
|------|------|--------------|-------|
| `/` | 200 | text/html; charset=UTF-8 | 8035 |
| `/style.css` | 200 | text/css; charset=UTF-8 | 17119 |
| `/client.js` | 200 | application/javascript; charset=UTF-8 | 41627 |
| `/socket.io/socket.io.js` | 200 | application/javascript; charset=utf-8 | 155836 |

index.html wiring confirmed: references `style.css` + `client.js` + `/socket.io/socket.io.js`;
contains `#screen-config` with `#modeClassic/#modeChaos/#modeDesc`, `#chaosOptions`
(`#dimsPicker`, `#fairyToggles`, `#rosterEditor`), side panel (`#cfgSummary`, `#cfgError`,
`#agreedYou`, `#agreedOpp`, `#cfgVersion`, `#agreeBtn`); `#modeBadge`; `#promoChoices`
(dynamic, hard-coded promo buttons removed); `#setupHint`.

---

## 2. Contract conformance (client side) — PASS

### Emits (client → server)
| Event | Payload sent by client | Contract | Verdict |
|-------|------------------------|----------|---------|
| `proposeConfig` | `{config:{mode,boardDims{cols,rows},bannedTypes[],roster{},enabledFairy[]}}` (client.js:211) | `{config}` C | OK |
| `agreeConfig` | `{version: cfgState.version}` (client.js:1058-1061) | `{version}` current | OK — stale (wrong version) verified ignored+resync live |
| `submitArrangement` | `{placement}` (client.js:1066) | E | OK |
| `requestMoves` | `{square}` (client.js:726) | v1 | OK |
| `makeMove` | `{from,to,promotion}` promotion may be fairy letter (client.js:737, 754-755) | D | OK |
| `resign` | `{}` (client.js:1091) | v1 | OK |
| `rematch` | `{}` (client.js:1095) | v1 | OK |

### Listeners (server → client)
| Event | Fields client reads | Server sends (verified) | Verdict |
|-------|---------------------|-------------------------|---------|
| `assigned` | `color, role` (866) | `{color,role}` | OK |
| `rejected` | `reason` (874) | `{reason:'full'}` | OK |
| `waiting` | `message` (880) | `{message}` | OK |
| `config` | `config, agreed, version, valid, error` (885-896) | identical (buildConfigPayload) | OK |
| `arrangementAccepted` | (flag) (898) | `{ok}` | OK |
| `arrangementRejected` | `reason` (904) | `{reason}` | OK |
| `gameStart` | (noop; state follows) (910) | `{turn}` | OK |
| `legalMoves` | `square, moves[].{to,promotion}, hasMoves` (912) | identical | OK |
| `moveMade` | `from, to, entry.{text,own,ply,capture,...}` (919, 762-776) | identical; opp entry anonymized | OK |
| `errorMsg` | `message` (925) | `{message}` | OK |
| `check` | `inCheck, checkSquare` (927) | classic only | OK (never fires in chaos — verified) |
| `capture` | `capturedType, capturedColor, square` (936) | identical | OK |
| `state` | `phase,yourColor,mode,boardDims,config,agreed,configVersion,turn,yourTurn,inCheck,checkSquare,board,moveLog,setup,result,opponentConnected,yourReady,opponentReady` | all present (buildState) | OK |
| `gameOver` | `result,winner,reason,fullBoard,fen` (1000, renderEnd) | identical | OK |
| `rematchPending` | `by` (1005) | `{by}` | OK |

No field-name mismatches, no missing handlers. Every v1 event still handled.

---

## 3. Config screen behavior — PASS

Live E2E (`e2e-front.js`) two-client negotiation on port 3200:

- Both clients enter **config** on connect: receive `config` event AND `state` (phase config)
  with `config`/`agreed`/`configVersion`. Client seeds `cfgState`+`draftConfig`
  (seedConfigFromState client.js:189, config handler 885). OK.
- **Mode toggle**: `#modeClassic`→`applyEditAndPush(d.mode="classic")` forces classic preset
  via `cleanConfig` (client.js:150-151, 1049); `#modeChaos` keeps/defaults roster and reveals
  `#chaosOptions` (1052, renderConfig:232). OK.
- **Dims picker** 8×8/10×8/10×10 (DIM_CHOICES, renderDimsPicker:267). OK — 10×10 propose→setup
  verified.
- **Fairy enable toggles**: enabling adds to `enabledFairy` + surfaces roster stepper;
  disabling removes from roster (renderFairyToggles:281-302). OK.
- **Roster steppers** per standard + enabled fairy, +/- with ban checkbox (renderRosterEditor:304).
  **King guard**: minus disabled at count 1, ban checkbox disabled for king (328, 353); local
  validity requires `roster.k>0` (validateLocal:174). OK.
- **Ban toggle** removes a type from roster/tray (355-358, cleanConfig drops banned). Verified:
  proposing chaos with `bannedTypes:["b"]` → server keeps `b` out of roster and promotionTypes
  (`["q","r","n","a","i"]`). OK.
- **Emits proposeConfig on every edit** (applyEditAndPush:211). OK.
- **Live opponent proposal**: `draftConfig` re-cloned from every `config` broadcast (894), so an
  opponent edit updates my controls/summary live. OK.
- **Agree** emits `agreeConfig{version:cfgState.version}`; disabled when already agreed or
  `valid===false` (262-264). OK.
- **Editing after agree resets agreed**: applyEditAndPush optimistically clears both `agreed`
  (215) and server bumps version+resets (verified: propose bumped v1→v2, agreed both false).
- **Validity/error** from `config` event shown in `#cfgError`, Agree blocked while invalid
  (251-258, 263). OK.
- **Stale agree** (wrong version) → server re-broadcasts `config`, client resyncs; agreed stays
  false (verified live).

---

## 4. Generalized board — PASS

- Square parse uses mandatory regex `SQ_RE = /^([a-z])([0-9]{1,2})$/` (client.js:80); `fileOf`
  returns leading letter, `rankOf` = `parseInt(m[2])` — correct for `a10`/`j10`, never `sq[1]`
  (83-84).
- Squares built from dims: `filesFor`/`ranksFor`/`orderedSquares` (87-108); `applyDims` sets
  `grid-template-columns/rows: repeat(cols|rows,1fr)`, `aspect-ratio`, `--cols/--rows` inline
  (110-116). CSS `.board` uses `--cols/--rows` with `grid-template-rows` for **equal squares**
  (style.css:97-107). OK.
- Orientation viewer-at-bottom for both colors, any dims (orderedSquares:97-108). Verified:
  White home ranks [1,2], Black home ranks [9,10] on 10×10; black back rank renders at bottom.
- Live: 10×10 filtered board and full board each keyed by exactly **100** squares; setup board
  (all-null) keyed by 100. Classic 8×8 → 64 keys, standard geometry/parity unchanged.

---

## 5. FOG in the client — PASS (no leaks) — highest priority

- `pieceNode(type,color)` (renders glyph/fairy badge) is called ONLY for own pieces
  (`cellVal.type`, client.js:679) and the reveal (`revealed`, 676). Opponent cells
  (`{occupied:true}`) hit the `unknownMarker()` neutral token branch (681-685) — identical for
  standard AND fairy. **No code path renders an opponent type/badge/glyph from `state.board`.**
- Reveal branch (`revealed===true`) reached ONLY from `gameOver.fullBoard` (renderEnd:853-855;
  `endRevealed = over.revealed!==false && !!over.fullBoard`). The phase-`ended` `state` fallback
  passes `revealed:false` so fog holds until `gameOver` lands (client.js:993).
- Fairy badges (`.piece.fairy`) styled only under own/reveal; opponent fairy → `.unknown`
  (style.css:144-164 comment + confirmed).
- Pins are client-side only; never emitted (no socket.emit references pins).

**Live fog audit** (generalized to `cols*rows` keys + fairy types `a c h i m w`) over full
sessions:
- 10×10 chaos with fairy: own Amazon at `d2` → W sees `{type:"a",color:"w"}`, **B sees
  `{occupied:true}`** (no type leak). W/B filtered boards: **0 leaks**. Session-wide
  state+moveMade audit (both viewers): **0 leaks**.
- `gameOver.fullBoard` (100 keys) reveals real types for both colors (as intended).
- 8×8 chaos + 8×8 classic: opponent `moveMade` entries anonymized (`"unknown piece: e1->f3"` /
  `"e2->e4"`), no `piece`/`san` fields.

---

## 6. Setup generalization — PASS

- Tray built from `state.setup.roster` incl. fairy counts and multiple kings/queens
  (trayOrder:422, renderTray:515). Verified live with roster `{k:2,q:1,r:2,n:2,p:6,a:1,i:1}`
  → reached playing (multi-king accepted).
- `"N / total placed"` and Ready-at-complete generalized (`rosterTotal`, updateReady:582-585).
- Home region from `state.setup.homeRanks` + dims (homeRanksArr:414, isHomeSquare:415,
  renderSetup filters orderedSquares). Setup grid rows = `homeRanks.length` via applyDims:433
  (supports N=3 home ranks on 10-tall boards).
- Fairy pieces render as badges in tray/in-hand/board (pieceNode). Promotion modal built from
  `state.setup.promotionTypes` (may include fairy) (renderPromoChoices:744-760); verified
  promotionTypes `["q","r","n","a","i"]` served for a chaos config with `b` banned + fairy.
- `submitArrangement` payload unchanged `{placement:{square:type}}`.

---

## 7. Chaos specifics — PASS

- No check banner in chaos: `renderGame` reads `state.inCheck` (always false in chaos —
  verified after a real chaos move); no `check` event fires in chaos (verified 0 on both
  clients). client.js:636-645.
- End screen maps `kingCaptured → "King captured"` and `stalemate` (chaos draw) (renderEnd
  resultTxt:833-837); renders `gameOver.fullBoard` for variable dims with fairy badges both
  colors. `fen:null` tolerated (reasonLine only appends FEN when truthy, 848).
- Rematch returns to **config** screen: verified live (both `rematch` → `state.phase:"config"`
  + `config` event, version bumped); client case `"config"` resets + renders (957-969).

---

## 8. Robustness — PASS

- `state` handled in every phase (switch lobby/config/setup/playing/ended, 957-997);
  `resetForNewGame` on entering config/setup from another screen.
- No runtime errors observed across classic + chaos + 10×10 + resign + rematch sessions.
- Classic path visibly unchanged: standard roster, 64 keys, q/r/b/n promo, standard glyphs,
  same orientation/parity; only added step is the trivial config both-agree.

---

## Issues found

No CRITICAL or HIGH issues. No fog leaks. No contract breaks. No missing handlers or
field mismatches.

### Minor / observational (not frontend defects)

- **[LOW — server, out of frontend scope]** The single in-memory match does not reset from
  `ended` when both players disconnect (`src/game.js` handleDisconnect only resets from
  config/setup, lines 138-150). A fresh pair connecting after an `ended` game stays stuck (no
  `config`). Reconnect is explicitly out of scope in the plan; noted only because it complicates
  repeated E2E runs (worked around by restarting the server). Not a client issue.
- **[INFO]** `.setupGrid` CSS hard-codes `aspect-ratio:4/1` / `repeat(2,1fr)` but `applyDims`
  overrides inline per dims/home-rank count — correct for N≠2; the CSS default is only a
  pre-render fallback. No bug.
- **[INFO]** `validateLocal` is a client mirror for snappy pre-echo feedback; server `config`
  event is authoritative and refines `valid`/`error`. Formula matches CONTRACT B.6
  (`roster.k>=1`, `2*max(2,ceil(total/cols))<=rows`). No divergence found.

---

## How verified
- Static review: full read of index.html, style.css, client.js; cross-checked every socket
  emit/listen and every field access vs CONTRACT-v2 §C/D/E/G; ID cross-check script.
- Live (port 3200, socket.io-client): `e2e-front.js` (config negotiation, 10×10 chaos + fairy,
  fog audit, gameOver reveal), `e2e-moves.js` (chaos move round-trip, no check event),
  `e2e-classic.js` (classic backward-compat), `rematch.js` (ended→config). All scratchpad-only.
- App source left untouched; server started/stopped by the tester only.
