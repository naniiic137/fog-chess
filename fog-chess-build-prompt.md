# Fog Chess — Build Prompt

*(Working name — rename as you like. Concept is close to the classic hidden-information chess variant "Kriegspiel," with two twists: players secretly arrange their own pieces before the game, and each player can privately "pin" a guess onto squares they think they've identified.)*

Paste everything below to whatever AI/tool is building this (Claude Code, Cursor, another chat, etc.) as your build spec.

---

## What you're building

A two-player, real-time, **local-network (LAN)** web app. Both players connect from separate devices on the same WiFi. Before the game, each player secretly arranges their own 16 pieces however they like on their own two home ranks. During the game, all standard chess rules apply, but neither player can see what type the opponent's pieces are — only whether a square is occupied, and how things move. Players can leave private "pin" markers on opponent squares to record their guesses.

## Core design principle — read this first

Keep the chess rules engine **completely standard and full-information internally.** The fog-of-war is purely a view/transport filter applied when sending state to each client — it is not a change to the rules engine.

- The server always holds the true, complete board state and enforces standard chess legality (movement, check, checkmate, stalemate, castling, en passant, promotion) with 100% information — exactly like a normal chess engine.
- Use an existing, tested move-generation library server-side (e.g. `chess.js` for JS) rather than writing one from scratch. Only extend it for: (a) arbitrary starting arrangement instead of the fixed back rank, and (b) Chess960-style castling (since "king/rook haven't moved" replaces "king/rook are on e1/a1/h1").
- Each client only ever receives a **filtered** copy of the board:
  - Full detail (piece type + color) for their own pieces.
  - "Occupied" or "empty" only, for opponent squares — never the type.
  - Opponent piece type is revealed only when captured (default; configurable — see below).

Isolating all the hidden-info logic into one filter function is what keeps this buildable and bug-resistant. Don't let fog logic leak into the actual rules engine.

## Game flow

1. Lobby / LAN connect
2. Setup (secret arrangement)
3. Live game
4. Pins (available throughout the live game)
5. End of game / rematch

### 1. Lobby & LAN connection
- Host runs the local server (`npm start`) on their machine.
- Server prints its LAN address to the console, e.g. `http://192.168.1.42:3000`.
- Player 1 (host) opens that address in their own browser; Player 2 opens the **same** address from their own device on the same WiFi.
- First two connections become White / Black. One active match at a time in v1 — no room codes needed yet.
- Show a plain "waiting for opponent" screen until both are connected.

### 2. Setup / arrangement phase
- Each player sees **only their own** two home ranks (e.g. ranks 1–2 for White, 7–8 for Black), with their standard 16 pieces (8 pawns, 2 rooks, 2 knights, 2 bishops, 1 queen, 1 king) in a tray to drag into place.
- Any piece on any of their 16 home squares, in any arrangement — full freedom.
- Opponent's arrangement screen is invisible to them; this happens in parallel on the other device.
- A "Ready" button locks it in. Game starts once both are ready.

### 3. Live game phase
- Standard alternating turns, White first.
- On your turn: your own pieces show in full detail. Select one and the app highlights its legal destination squares (computed server-side with full information — no blind guessing needed for your *own* moves).
- Opponent pieces render as neutral "unknown occupied" markers (e.g. a `?` or plain tint) — never their real icon.
- When the opponent moves, show the from-square → to-square transition so the identity-guessing game stays intact (that motion is the only clue you get).
- **Captures (default):** the captured piece's type is revealed to both players once it's off the board; the *capturing* piece stays hidden unless it's your own. Make this a config flag (`revealCapturedPieceType: true`) so it can be flipped for a harder mode later.
- **Check (default):** the checked player is told "you are in check" and the checking piece's *square* is highlighted — position shown, identity withheld. Keeps it fair without giving away the answer.
- Checkmate / stalemate / draw: computed normally, server-side, full information. Reveal both full boards at game end.
- Move log: each player's own copy shows their own moves in full and the opponent's moves as anonymized (e.g. "unknown piece: e2→e4").

### 4. Pins (private guess markers)
- Either player can click any occupied opponent square and attach a personal guess: Pawn / Knight / Bishop / Rook / Queen / King, or free text.
- 100% private — never transmitted to the opponent. Pure memory aid layered on the board.
- Displays as a small icon/letter overlay only that player sees.
- If the square empties (piece moved off it), auto-fade the pin — the guess no longer applies there. Player can manually re-pin wherever they think that piece went.
- Store as `pins[playerId][square] = { guess, note? }`.

### 5. End of game
- Reveal both boards fully, show result, offer "Rematch" (returns both to setup phase).

## Suggested tech stack

- **Backend:** Node.js + Express + Socket.io for real-time sync. `chess.js` for move generation/validation/check/mate detection.
- **Frontend:** plain HTML/CSS/JS, no build step. CSS grid or a `<table>` for the 8x8 board — no canvas library needed.
- **State:** in server memory only (one active match) — no database needed for v1.
- No accounts, no HTTPS required for LAN play.

## Data model sketch

```
game = {
  players: { white: socketId, black: socketId },
  phase: "lobby" | "setup" | "playing" | "ended",
  board: <chess.js instance — full truth, server-only, never sent raw>,
  arrangementReady: { white: bool, black: bool },
  pins: { white: { [square]: guess }, black: { [square]: guess } },
  moveLog: [...],
  turn: "white" | "black",
  result: null | "checkmate" | "stalemate" | "resign"
}
```

## The filter function (the whole trick)

```
visibleBoard(square, forColor):
  if square has a piece of color === forColor -> { type, color }
  elif square has a piece of the other color   -> { occupied: true }   // no type
  else                                          -> empty
```
Run this on every board update before emitting to each socket. Never emit the raw board.

## UI requirements

- Arrangement screen: 2 home ranks + piece tray + Ready button.
- Waiting screen for lobby/setup sync.
- Board screen: 8x8 grid, your pieces in full color/icon, opponent occupied squares as neutral markers, legal-move highlighting on your own piece selection, turn indicator, check banner, capture log, resign/rematch buttons.
- Pin layer: click opponent square → pick a guess → overlay icon persists until cleared/faded.

## v1 scope

**In:** one match at a time, 2 devices on the same WiFi, full standard chess rules adapted for custom arrangement (incl. Chess960-style castling, en passant, promotion), fog-of-war view filtering, pins, capture-reveals-type default, check-reveals-square-not-type default.

**Out (call these out as later improvements, don't build now):** reconnect-after-disconnect handling, multiple simultaneous rooms, spectators, clocks/timers, animation polish, mobile gesture support, internet deployment.

## One-line version to paste if you want something shorter

> Build a 2-player LAN chess variant using chess.js for full server-side rule enforcement and Socket.io for real-time sync. Add a pre-game phase where each player secretly arranges their own 16 pieces on their own two home ranks. During play, filter all board updates so each client only sees full detail on their own pieces and "occupied/empty" for the opponent's — never opponent piece type, except on capture. Let players place private guess "pins" on opponent squares that are never sent to the opponent. Ship as a single Node.js project runnable via `npm install && npm start`, printing the LAN URL to the console so a second device on the same WiFi can connect.
