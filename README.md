# Fog Chess ♟️🌫️

A two-player, real-time **hidden-information chess variant** for your local network (LAN).
Two people on the same WiFi each open the same web page from their own device and play
chess where **you cannot see what type your opponent's pieces are** — only that a square is
occupied. Before the game, each player **secretly arranges their own 16 pieces** however they
like on their two home ranks.

It is close to the classic hidden-information variant **Kriegspiel**, with two twists:

1. **Secret setup** — you arrange your own back two ranks in any order before the game.
2. **Private pins** — you can drop private guess-markers on the opponent's squares to track
   what you think each hidden piece is. Your opponent never sees them.

The chess rules themselves are 100% standard and enforced with full information on the
server (via [`chess.js`](https://github.com/jhlywa/chess.js)); the "fog of war" is purely a
**per-player view filter** applied right before the board is sent to each client. The raw
board is never transmitted.

---

## Table of contents

- [Features](#features)
- [How the fog works (design)](#how-the-fog-works-design)
- [Requirements](#requirements)
- [Installation](#installation)
- [Running the game](#running-the-game)
- [Connecting a second device (LAN)](#connecting-a-second-device-lan)
- [How to play](#how-to-play)
- [Configuration](#configuration)
- [Project structure](#project-structure)
- [Architecture](#architecture)
- [Troubleshooting](#troubleshooting)
- [Rules notes & known limitations](#rules-notes--known-limitations)
- [Roadmap](#roadmap)
- [Development & testing](#development--testing)
- [Tech stack](#tech-stack)
- [License](#license)

---

## Features

- **Real-time two-player play** over LAN using WebSockets (Socket.io).
- **Secret arrangement phase** — place your 16 pieces anywhere on your own two home ranks
  (full freedom, including pawns on your back rank).
- **Fog of war** — opponent pieces show only as a neutral "hidden piece" token; their real
  type is never sent to you.
- **Full standard chess rules** — legal move generation, check, checkmate, stalemate,
  draws, en passant, and promotion, all enforced server-side with complete information.
- **Capture reveals** — when a piece is captured, its type is revealed to both players
  (configurable). The *capturing* piece stays hidden.
- **Fair check** — you're told when you're in check and the checking piece's **square** is
  highlighted, but its identity stays hidden.
- **Private pins** — click any occupied opponent square to record a private guess
  (Pawn/Knight/Bishop/Rook/Queen/King or free text). Never transmitted; auto-fades when the
  square empties.
- **Click-to-place or drag-and-drop** setup.
- **Adjustable board size** (Small / Normal / Large / Huge), saved per browser.
- **Resign** and **rematch** (rematch returns both players to a fresh setup, colors kept).
- **Full reveal** of both boards at game end.
- No build step, no database, no accounts — just `npm install && npm start`.

---

## How the fog works (design)

The single most important design rule:

> **The rules engine is completely standard and full-information. The fog is only a view
> filter applied when sending state to each client — never a change to the rules.**

- The **server** always holds the true, complete board and enforces standard chess legality
  with 100% information, exactly like a normal engine.
- Each client only ever receives a **filtered** copy of the board:
  - Full detail (`{type, color}`) for **their own** pieces.
  - `{occupied: true}` (no type, no color) for **opponent** squares.
  - `null` for empty squares.
- The raw, full board is emitted in exactly **one** place: the `gameOver` event at the end
  of the game, for the final reveal.

All of this hidden-info logic lives in a single function (`src/fog.js`) so it cannot leak
into the rules engine. This design was verified by an automated audit that scanned every
board in every message across many games and confirmed **zero** opponent-type leaks.

---

## Requirements

- **[Node.js](https://nodejs.org/) 18 or newer** (includes `npm`). Check with:
  ```bash
  node -v
  npm -v
  ```
- Two devices (phones, tablets, or computers) on the **same WiFi / LAN**. You can also test
  solo by opening two browser tabs/windows on the host machine.
- A modern browser (Chrome, Edge, Firefox, or Safari).

No internet connection is required once dependencies are installed — the game runs entirely
on your local network.

---

## Installation

1. **Get the code.** Clone the repository (or download the ZIP and extract it):
   ```bash
   git clone https://github.com/naniiic137/fog-chess.git
   cd fog-chess
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```
   This installs `express`, `socket.io`, and `chess.js` into `node_modules/`.

---

## Running the game

Start the server on the **host** machine (the computer that will run the game):

```bash
npm start
```

You'll see something like:

```
Fog Chess running at:
  http://localhost:3000
  http://192.168.1.42:3000
```

- On the **host**, open `http://localhost:3000` in a browser.
- On the **second device**, open the `http://192.168.x.x:3000` address shown in the console
  (see the next section).

The **first two** browsers to connect become **White** and **Black**. A third connection is
told the match is full. One match runs at a time.

### Changing the port

The default port is `3000`. To use another (e.g. if 3000 is taken):

```bash
# macOS / Linux
PORT=4000 npm start

# Windows PowerShell
$env:PORT=4000; npm start

# Windows CMD
set PORT=4000 && npm start
```

---

## Connecting a second device (LAN)

1. Make sure **both devices are on the same WiFi network**.
2. On the host, note the `http://192.168.x.x:3000` line printed at startup — that's the
   host's LAN address. (If several are printed, use the one matching your WiFi adapter.)
3. On the second device's browser, type that full address (including `:3000`).
4. If it won't connect, it's almost always a **firewall** — see
   [Troubleshooting](#troubleshooting).

**Finding the host IP manually** (if needed):

- **Windows:** run `ipconfig` and look for "IPv4 Address" under your WiFi adapter.
- **macOS:** System Settings → Wi-Fi → Details, or `ipconfig getifaddr en0`.
- **Linux:** `hostname -I` or `ip addr`.

---

## How to play

### 1. Lobby
When you connect you'll see a "waiting for opponent" screen until the second player joins.

### 2. Setup (secret arrangement)
- You see **only your own two home ranks** and a tray of your 16 pieces (8 pawns, 2 rooks,
  2 knights, 2 bishops, 1 queen, 1 king).
- **To place:** click a piece in the tray to "pick it up," then click a home square to drop
  it. Keep clicking squares to place more of the same type. You can also **drag** pieces.
- **To remove:** click a placed piece (with nothing in hand), or drag it off.
- Shortcuts: **Standard setup** fills the normal chess formation; **Clear** empties the board.
- Your opponent is arranging their side at the same time — you can't see it.
- Press **Ready** once all 16 pieces are placed. The game starts when both players are ready.

### 3. Live game
- White moves first, then players alternate.
- **Your pieces** show in full. Click one to see its legal destination squares highlighted,
  then click a highlighted square to move.
- **Opponent pieces** appear as a neutral grey **hidden-piece token** — you never see their
  type. When your opponent moves, the from→to squares flash so you can track the motion.
- If a pawn reaches the last rank you'll be asked what to **promote** to.
- **Captures:** the captured piece's type is announced to both players (the capturing piece
  stays hidden). Captures are noted in the move log.
- **Check:** if you're in check, a banner appears and the checking piece's **square** is
  outlined — but its identity stays secret.
- The **move log** shows your own moves in full and your opponent's as anonymized entries
  like `unknown piece: e7→e5`.

### 4. Pins (private guesses)
- Click any occupied **opponent** square to attach a private guess (a piece type or free
  text). It shows as a small purple tag only **you** can see.
- Pins are **never** sent to your opponent.
- When the piece leaves that square, the pin fades away automatically. Re-pin wherever you
  think it went.

### 5. End of game
- On checkmate, stalemate, draw, or resignation, **both boards are fully revealed** and the
  result is shown.
- Click **Rematch** to play again (both must accept); you return to a fresh setup phase with
  the same colors.

---

## Configuration

Server-side options live at the top of the game logic as a `CONFIG` object (see
`src/game.js`):

| Option                    | Default | Effect                                                                 |
|---------------------------|---------|------------------------------------------------------------------------|
| `revealCapturedPieceType` | `true`  | When `true`, a captured piece's type is revealed to both players. Set `false` for a harder, fully-blind mode. |

Client-side:

- **Board size** — the Small/Normal/Large/Huge selector in the top bar (saved per browser
  in `localStorage`).

Environment:

- **`PORT`** — the TCP port the server listens on (default `3000`).

---

## Project structure

```
fog-chess/
├── server.js              # Express + Socket.io server; connection & event handling; LAN URL printout
├── package.json           # Dependencies and the "start" script
├── src/
│   ├── game.js            # Game state machine (lobby→setup→playing→ended), rules via chess.js, CONFIG
│   ├── fen.js             # Builds a chess.js FEN string from the two secret arrangements
│   └── fog.js             # THE fog filter — the only place hidden-info logic lives
├── public/                # Static frontend (served as-is, no build step)
│   ├── index.html         # Markup for all screens (lobby / setup / game / end) + modals
│   ├── style.css          # Styling, board grid, pieces, hidden-piece token, pins
│   └── client.js          # All client logic: rendering, setup, moves, pins, socket wiring
├── PLAN.md                # Implementation plan
├── CONTRACT.md            # The binding Socket.io event contract (payload shapes)
├── transcripts/           # Build/test transcripts (how it was made & verified)
└── README.md              # This file
```

---

## Architecture

- **Backend:** Node.js + Express serves the static `public/` folder; Socket.io handles
  real-time messaging. `chess.js` provides move generation, legality, check/checkmate/
  stalemate/draw detection, en passant, and promotion.
- **Custom arrangement → FEN:** the two players' secret placements are composed into a FEN
  string (`src/fen.js`) and loaded into `chess.js` with validation skipped (so unusual but
  legal-for-this-variant positions, like a pawn on the back rank, are allowed). The castling
  field is always `-` (castling is not part of v1).
- **Fog filter:** `src/fog.js` converts the true board into a per-viewer filtered board
  before every emit. Own pieces keep `{type,color}`; opponent pieces become `{occupied:true}`.
- **Contract:** the exact Socket.io event names and JSON payload shapes are documented in
  [`CONTRACT.md`](CONTRACT.md). The frontend and backend were built independently against
  this contract.
- **State:** everything lives in server memory. One match at a time; no database.

---

## Troubleshooting

**The second device can't reach the page / it just spins "Connecting…".**
Almost always a firewall on the host is blocking incoming connections to Node.

- **Windows:** the first time you run `npm start`, Windows may pop up a "Windows Defender
  Firewall" dialog — click **Allow access** (make sure **Private networks** is checked). If
  you dismissed it, go to *Windows Security → Firewall & network protection → Allow an app
  through firewall* and allow **Node.js**, or temporarily allow inbound TCP on your chosen
  port for the Private profile.
- **macOS:** *System Settings → Network → Firewall* — allow incoming connections for Node,
  or turn the firewall off briefly to test.
- Confirm both devices are on the **same** WiFi (not one on WiFi and one on a guest network
  or cellular).

**`Error: listen EADDRINUSE :::3000` (port already in use).**
Another program (or a previous copy of the game) is using port 3000. Start on another port:
`PORT=4000 npm start`.

**`npm install` fails.**
Ensure Node.js 18+ is installed (`node -v`). Delete `node_modules/` and
`package-lock.json` and run `npm install` again.

**"Match is full."**
Two players are already connected — Fog Chess supports one match at a time in v1. Close one
of the other tabs/devices and reload.

**A player disconnected mid-game.**
Reconnect handling is out of scope for v1. Refresh both browsers and start a new match.

---

## Rules notes & known limitations

- **No castling** in v1. Because pieces start in custom positions, castling is intentionally
  disabled.
- **Back-rank pawns:** you may place a pawn on your own back rank. Such a pawn advances one
  square at a time (it does not get the two-square first move until it reaches its 2nd rank).
  This is intended.
- **Promotion** works normally; if you don't choose a piece the game promotes to a Queen.
- **One match at a time**, single WiFi/LAN, in-memory state.

**Out of scope for v1 (see roadmap):** reconnect-after-disconnect, multiple simultaneous
rooms/room codes, spectators, clocks/timers, and internet (non-LAN) play.

---

## Roadmap

Planned / requested additions:

- **Custom piece counts** — play with more than one queen, extra kings, etc.
- **Piece bans** — both players agree to ban a piece type for the round; it's greyed out.
- **Wild / fairy pieces** — new pieces with unusual, long-range movement for chaos modes.
- **Game modes** — a "Classic" mode (standard rules) alongside a "Chaos" mode.
- Reconnect handling, multiple rooms, and optional timers.

---

## Development & testing

- Start the server: `npm start` (or `PORT=xxxx npm start`).
- The frontend is plain HTML/CSS/JS in `public/` — edit and refresh the browser; there is no
  build step or bundler.
- The `transcripts/` folder documents how the app was planned, built, and tested (including
  an automated fog-leak audit that drove real socket clients through full games).
- Syntax-check the client without a browser: `node --check public/client.js`.

---

## Tech stack

- **Node.js**, **Express** (static hosting) and **Socket.io** (real-time transport)
- **chess.js** for full-information rule enforcement
- Plain **HTML / CSS / JavaScript** frontend (no framework, no build step)

---

## License

No license has been specified yet. If you plan to make this public, add a `LICENSE` file
(e.g. MIT) to clarify how others may use it.
