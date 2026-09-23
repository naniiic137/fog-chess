# Agent 3 — Frontend Builder (v2) transcript

Scope: implement the complete v2 frontend (config negotiation, chaos mode, variable
boards, fairy pieces) in `public/` WITHOUT regressing the working classic UI. Built
strictly to `CONTRACT-v2.md` (which wins over PLAN-v2 and v1). Files touched (only
these): `public/index.html`, `public/style.css`, `public/client.js`.

Verification: `node --check public/client.js` passes; CSS braces balance (163/163);
every `$("id")` referenced in JS exists in the HTML; every socket emit/listen
cross-checked against CONTRACT-v2 (see list at bottom).

---

## public/index.html — what changed

- Added a `#modeBadge` chip in the topbar (shows "Classic"/"Chaos" from `state.mode`).
- Added the NEW `#screen-config` section (house-rules negotiation), containing:
  - Mode toggle buttons `#modeClassic` / `#modeChaos` + `#modeDesc`.
  - `#chaosOptions` wrapper (hidden when Classic) with `#dimsPicker`,
    `#fairyToggles`, `#rosterEditor` (all populated by JS).
  - A sticky side panel: `#cfgSummary` (live proposal), `#cfgError` (validity),
    `#agreedYou` / `#agreedOpp` chips, `#cfgVersion`, and `#agreeBtn`.
- Setup screen: gave the primary hint the id `#setupHint` so JS can rewrite it for
  N home ranks. Left the trayCount/auto-fill/clear/ready controls as-is
  (auto-fill button text is relabeled by JS per mode).
- Promotion modal: replaced the four hard-coded promo buttons with an empty
  `#promoChoices` container that JS fills dynamically from
  `state.setup.promotionTypes` (so a fairy promotion option like `a` can appear).
- Pin modal left unchanged (pins are standard-piece guesses; still client-side).

## public/style.css — what changed

- Board grid generalized: `.board` now uses `--cols`/`--rows` custom properties
  (default 8/8, overridden inline per `boardDims`) for
  `grid-template-columns/rows`. `.sq` font-size switched from the hard-coded `/8`
  to `min(calc(50vw / var(--cols)), calc(var(--board-max) / var(--cols) * 0.72))`
  so 10-wide boards shrink glyphs to keep equal squares. Classic (cols=8) renders
  essentially identically (6.25vw vs the old 6.2vw).
- Fairy badges (`.piece.fairy` + `.fairy-a…w`): distinct accent color per fairy
  (violet/teal/orange/blue/sand/magenta), uppercase letter, and an owner ring
  (light ring for white, dark ring for black) so both colors are distinguishable
  in the end-screen reveal. Sized in `em` so they scale with any square/tray size.
- Registered `body[data-screen="config"] #screen-config` in the screen-visibility
  rule and styled `#modeBadge`.
- Added config-screen styles: mode toggle, dims picker, fairy chips, the roster
  editor rows with +/- steppers and ban checkboxes, the proposal summary, and the
  agreed chips. Added `.promoBtn`/`.promoLbl`/`.trayGlyph` tweaks for the dynamic
  promotion buttons and fairy-in-tray rendering.
- The existing dark theme, `.unknown` veiled-piece token, movehints, pins, modals,
  toast are untouched.

## public/client.js — full rewrite (behavior-preserving for classic)

Rewrote the client to drive everything off `state` (`phase`, `mode`, `boardDims`,
`config`, `setup`), while keeping every v1 code path intact for classic.

---

## Config negotiation screen (phase "config") + agreement-reset handling

State model:
- `cfgState = { config, agreed, version, valid, error }` — the authoritative shared
  proposal, updated from the `config` broadcast (and seeded from `state.config` /
  `state.agreed` / `state.configVersion` if a `state` for phase config arrives
  first, assuming `valid:true` until the `config` event refines it).
- `draftConfig` — the locally-editable config; always re-cloned from the shared
  config on each broadcast, so an OPPONENT edit updates my controls live.

Editing: every control change routes through `applyEditAndPush(mutator)`:
1. mutate `draftConfig`, then `cleanConfig()` it (drop banned/zero/disabled-fairy
   entries; classic mode is forced to the classic preset);
2. `socket.emit("proposeConfig", { config })`;
3. optimistically clear both `agreed` flags locally and recompute validity with
   `validateLocal()` (a client mirror of CONTRACT-v2 B.6: `roster.k>=1`, total>=1,
   and home-fit `2*max(2,ceil(total/cols)) <= rows`), then re-render.
The authoritative `config` broadcast (with server `valid`/`error`/`version`) then
overwrites `cfgState` and re-syncs `draftConfig`.

Agreement-reset rule: the `agreedYou`/`agreedOpp` chips render straight from
`cfgState.agreed[side]`. Because any local edit optimistically clears them (and the
server bumps `version` + resets both on `proposeConfig`), editing visibly clears the
agreement immediately and again when the broadcast lands. Agree button emits
`agreeConfig { version: cfgState.version }` for the CURRENT version; it is disabled
when I've already agreed or when `valid===false`. When both agree and it's valid the
server sends a `state` with phase `setup`, which the client just renders.

Controls:
- Mode toggle: Classic forces `cleanConfig` → classic preset (quick both-agree path).
  Chaos keeps the current roster (defaulting to the standard army) and reveals
  `#chaosOptions`.
- Board dims: 8×8 / 10×8 / 10×10 buttons.
- Fairy enables: one chip per fairy (a c h i m w); enabling adds it to
  `enabledFairy` and surfaces its roster stepper; disabling removes it from the
  roster.
- Roster steppers: per standard type (k q r b n p) + each enabled fairy, with
  +/- and a "ban" checkbox. King guard is enforced client-side: king's minus is
  disabled at count 1 and its ban checkbox is disabled (can't zero all kings). A
  banned type is removed from the roster and its stepper disabled.
- Live summary + error string from the config event are shown in the side panel.

## Board generalization (variable dims + square parsing)

- `dims = {cols,rows}` is a module var updated by `syncDims(state)` from
  `state.setup.boardDims` (setup) / `state.boardDims` (lobby/config/playing/ended) /
  `state.config.boardDims`.
- Square parsing uses the MANDATORY regex `^([a-z])([0-9]{1,2})$`: `fileOf` returns
  the leading letter, `rankOf` returns `parseInt` of the trailing digits — correct
  for `a10`/`j10` (never `sq[1]`). `fileIndex`/`fileLetter` map `a↔0 … j↔9`.
- `isLight = (fileIndex(file)+rank)%2===1` — identical parity to v1 for 8×8.
- `orderedSquares(color, dims)` builds files `a..a+cols-1` and ranks `1..rows`, with
  the viewer at the bottom (White: ranks high→low, files a→last; Black: ranks
  low→high, files reversed) for any dims.
- `applyDims(container, dims)` sets `grid-template-columns/rows`, `aspect-ratio =
  cols/rows`, and the `--cols`/`--rows` vars inline on each board element (game,
  end, and setup — setup uses `rows = homeRanks.length`).

## Fairy badges vs opponent-hidden (fog) rendering

- `pieceNode(type,color,draggable)` is called ONLY for own pieces (`cellVal.type`)
  and for the end-screen reveal (`fullBoard`). Standard types → unicode glyph;
  fairy types → colored uppercase-letter badge (`A C H I M W`).
- In `renderBoard`, opponent cells (`{occupied:true}`, no `.type`) always fall to the
  `unknownMarker()` neutral `.unknown` token — identical for standard and fairy, so
  nothing leaks. There is NO branch that renders a type from a non-revealed board
  except `cellVal.type` (which, per contract, only exists for the viewer's OWN
  pieces). The reveal branch (`revealed===true`) is reached ONLY from
  `gameOver.fullBoard`.

## Roster tray + promotion generalization

- Setup reads `state.setup = { roster, boardDims, homeRanks, bannedTypes,
  enabledFairy, promotionTypes }` (with a classic fallback if absent). The home
  region is `orderedSquares(...).filter(rank ∈ homeRanks)`; tray slots come from
  `roster` (standard order q k r b n p, then present fairy), each showing `xN`
  remaining. "Ready" enables when placed count === `sum(roster)` (generalized from
  16). Click-to-place and drag both work; fairy pieces render as badges in tray,
  in-hand, and on the board. `submitArrangement` payload is unchanged:
  `{ placement: {square: pieceType} }`.
- Auto-fill: classic uses the exact v1 standard arrangement; chaos uses a generic
  back-rank-first fill of the roster across the home region. Button relabels
  "Standard setup" (classic) / "Auto-fill" (chaos).
- Promotion: `promotionTypes` is captured from `state.setup.promotionTypes` and the
  promo modal is built dynamically (glyph or fairy badge + name); the chosen letter
  is sent in `makeMove.promotion`. Classic still offers q/r/b/n.

## Move log, check, end screen

- Move log renders `entry.text` verbatim, so chaos own entries show the piece name
  and opponent entries stay `"unknown piece: b9->b10"`. No change needed.
- Check banner is driven by `state.inCheck`; chaos always sends `false`, so it never
  shows in chaos (and no `check` event fires there).
- End screen adds `kingCaptured → "King captured"` and keeps `stalemate` (chaos
  draw). Reveal renders `gameOver.fullBoard` for the current dims with fairy badges
  for both colors. Rematch returns to the config phase — the client just renders the
  incoming `state` (phase config), resetting local game artifacts on entry.

---

## Socket events (cross-checked vs CONTRACT-v2)

Emit (client→server): `proposeConfig {config}`, `agreeConfig {version}`,
`submitArrangement {placement}`, `requestMoves {square}`,
`makeMove {from,to,promotion}`, `resign {}`, `rematch {}`.

Listen (server→client): `connect`, `disconnect`, `assigned`, `rejected`, `waiting`,
`config {config,agreed,version,valid,error}`, `arrangementAccepted`,
`arrangementRejected`, `gameStart`, `legalMoves`, `moveMade`, `errorMsg`, `check`,
`capture`, `state`, `gameOver`, `rematchPending`. All match the v2 additions +
v1 set.

---

## Risks / notes for testers

- FOG (priority #1): opponent squares arrive as `{occupied:true}` and can only
  render as `.unknown`; the only type-rendering path for non-own pieces is the
  `revealed` branch, reached solely from `gameOver.fullBoard`. Confirm opponent
  fairy pieces show the SAME veiled token as opponent standard pieces (no
  badge/letter), on 8×8, 10×8, and 10×10. Pins are never emitted.
- Classic regression (priority #2): classic sends `mode:"classic"`,
  `boardDims:{8,8}`, standard roster, standard glyphs; geometry/parity/orientation
  match v1. The only new step is the trivial config both-agree before setup. Verify
  a full classic game (check, en passant, promotion, checkmate, resign, rematch).
- Config race: on very fast successive edits the `draftConfig` is re-synced from
  each `config` echo; a momentary flicker is possible but converges to the last
  edit. Agree always targets `cfgState.version`; a stale agree is ignored+resynced
  by the server per contract.
- The client trusts the server's fog filter; it never derives or caches opponent
  types, so there is no independent leak surface. Validity shown is the server's
  `config.error`; `validateLocal` is only for snappy pre-echo feedback.
- Board font scaling for 10-wide boards is CSS-var driven; on very small viewports
  glyphs shrink further via the `50vw/cols` term.
