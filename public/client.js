/* Fog Chess — frontend client.
 * Renders strictly from server payloads defined in CONTRACT.md.
 * Fog rule: opponent pieces are ONLY ever {occupied:true}; never a real type.
 * Pins are 100% client-side and never sent over the socket.
 */
(function () {
  "use strict";

  // ---------- constants ----------
  var FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
  var RANKS = [1, 2, 3, 4, 5, 6, 7, 8];

  var GLYPH = {
    w: { k: "♔", q: "♕", r: "♖", b: "♗", n: "♘", p: "♙" },
    b: { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" }
  };
  var TYPE_NAME = { p: "Pawn", n: "Knight", b: "Bishop", r: "Rook", q: "Queen", k: "King" };
  var FULL_COUNTS = { p: 8, r: 2, n: 2, b: 2, q: 1, k: 1 };
  var TRAY_ORDER = ["q", "k", "r", "b", "n", "p"];
  // short label for a pin overlay
  var PIN_LETTER = { Pawn: "P", Knight: "N", Bishop: "B", Rook: "R", Queen: "Q", King: "K" };

  // ---------- client state ----------
  var socket = io();
  var yourColor = null;          // "w" | "b"
  var lastState = null;          // last authoritative `state`
  var prevBoard = null;          // previous filtered board (for pin auto-fade)
  var pins = {};                 // { square: "Queen" | "free text" }
  var placement = {};            // setup: { square: pieceType }
  var selectedSquare = null;     // playing: currently selected own square
  var currentMoves = [];         // legalMoves entries for selectedSquare
  var lastMove = null;           // { from, to } for highlight
  var checkSquare = null;        // square to outline when in check
  var promoPending = null;       // { from, to } awaiting promotion choice
  var pinTargetSquare = null;    // square being edited in pin modal
  var pendingFlash = null;       // { from, to } to flash after next render

  // ---------- tiny DOM helpers ----------
  function $(id) { return document.getElementById(id); }
  function el(tag, cls) { var e = document.createElement(tag); if (cls) e.className = cls; return e; }
  function setScreen(name) { document.body.setAttribute("data-screen", name); }

  var toastTimer = null;
  function toast(msg, isErr) {
    var t = $("toast");
    t.textContent = msg;
    t.className = "toast" + (isErr ? " err" : "");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.add("hidden"); }, 2600);
  }

  // ---------- geometry / orientation ----------
  function sq(file, rank) { return file + rank; }
  function fileOf(s) { return s[0]; }
  function rankOf(s) { return parseInt(s[1], 10); }
  function isLight(s) {
    return (FILES.indexOf(fileOf(s)) + rankOf(s)) % 2 === 1;
  }

  // Board squares in DISPLAY order (top-left -> bottom-right), player at bottom.
  // White: rank 8..1, files a..h.  Black: rank 1..8, files h..a (180deg).
  function orderedSquares(color) {
    var out = [];
    var ranks = color === "b" ? RANKS.slice() : RANKS.slice().reverse();
    for (var r = 0; r < ranks.length; r++) {
      var files = color === "b" ? FILES.slice().reverse() : FILES.slice();
      for (var f = 0; f < files.length; f++) out.push(sq(files[f], ranks[r]));
    }
    return out;
  }

  function homeRanks(color) { return color === "w" ? [1, 2] : [7, 8]; }
  function isHomeSquare(color, s) { return homeRanks(color).indexOf(rankOf(s)) !== -1; }

  // ---------- generic board cell builder ----------
  function makeCell(s) {
    var cell = el("div", "sq " + (isLight(s) ? "light" : "dark"));
    cell.dataset.square = s;
    var coord = el("span", "coord");
    coord.textContent = s;
    cell.appendChild(coord);
    return cell;
  }

  function pieceSpan(type, color, draggable) {
    var p = el("span", "piece " + color + (draggable ? " draggable" : ""));
    p.textContent = GLYPH[color][type];
    return p;
  }

  function unknownMarker() { return el("div", "unknown"); }

  // =====================================================================
  //  SETUP SCREEN
  // =====================================================================
  function renderSetup() {
    var board = $("setupBoard");
    board.innerHTML = "";
    // only the player's two home ranks, oriented with player at bottom
    var squares = orderedSquares(yourColor).filter(function (s) {
      return isHomeSquare(yourColor, s);
    });
    squares.forEach(function (s) {
      var cell = makeCell(s);
      cell.classList.add("dropTargetZone");
      cell.addEventListener("dragover", function (ev) {
        ev.preventDefault();
        cell.classList.add("dropTarget");
      });
      cell.addEventListener("dragleave", function () { cell.classList.remove("dropTarget"); });
      cell.addEventListener("drop", function (ev) { onDropToSquare(ev, s, cell); });
      // existing placed piece
      if (placement[s]) {
        var p = pieceSpan(placement[s], yourColor, true);
        p.setAttribute("draggable", "true");
        p.addEventListener("dragstart", function (ev) {
          ev.dataTransfer.setData("text/plain", JSON.stringify({ origin: s, type: placement[s] }));
        });
        p.addEventListener("click", function () { removeFromSquare(s); });
        p.title = "Click or drag off to remove";
        cell.appendChild(p);
      }
      board.appendChild(cell);
    });
    renderTray();
    updateReady();
  }

  function placedCounts() {
    var c = {};
    for (var s in placement) { c[placement[s]] = (c[placement[s]] || 0) + 1; }
    return c;
  }

  function remaining(type) {
    var used = placedCounts()[type] || 0;
    return FULL_COUNTS[type] - used;
  }

  function renderTray() {
    var tray = $("tray");
    tray.innerHTML = "";
    TRAY_ORDER.forEach(function (type) {
      var rem = remaining(type);
      var item = el("div", "trayItem" + (rem <= 0 ? " empty" : ""));
      item.textContent = GLYPH[yourColor][type];
      var cnt = el("span", "count");
      cnt.textContent = "x" + rem;
      item.appendChild(cnt);
      if (rem > 0) {
        item.setAttribute("draggable", "true");
        item.addEventListener("dragstart", function (ev) {
          ev.dataTransfer.setData("text/plain", JSON.stringify({ origin: "tray", type: type }));
        });
      }
      tray.appendChild(item);
    });
    // tray is also a drop target (drag a placed piece here to remove it)
    tray.addEventListener("dragover", function (ev) { ev.preventDefault(); });
    tray.addEventListener("drop", function (ev) {
      ev.preventDefault();
      var data = parseDrag(ev);
      if (data && data.origin && data.origin !== "tray") removeFromSquare(data.origin);
    });
  }

  function parseDrag(ev) {
    try { return JSON.parse(ev.dataTransfer.getData("text/plain")); }
    catch (e) { return null; }
  }

  function onDropToSquare(ev, target, cell) {
    ev.preventDefault();
    cell.classList.remove("dropTarget");
    var data = parseDrag(ev);
    if (!data) return;
    if (!isHomeSquare(yourColor, target)) return;

    if (data.origin === "tray") {
      // place a fresh piece from the tray. Replacing a same-type square is fine;
      // replacing a different type frees that type only if we still have stock.
      if (remaining(data.type) <= 0 && placement[target] !== data.type) {
        toast("No more " + TYPE_NAME[data.type] + " in tray", true);
        return;
      }
      placement[target] = data.type;
    } else {
      // moving a placed piece from data.origin -> target (swap if occupied)
      var moving = placement[data.origin];
      if (moving === undefined) return;
      var occupant = placement[target];
      placement[target] = moving;
      if (occupant !== undefined && data.origin !== target) {
        placement[data.origin] = occupant; // swap
      } else {
        delete placement[data.origin];
      }
    }
    renderSetup();
  }

  function removeFromSquare(s) {
    delete placement[s];
    renderSetup();
  }

  function updateReady() {
    var n = Object.keys(placement).length;
    $("trayCount").textContent = n + " / 16 placed";
    $("readyBtn").disabled = n !== 16;
  }

  function standardSetup() {
    placement = {};
    var back = yourColor === "w" ? 1 : 8;
    var pawns = yourColor === "w" ? 2 : 7;
    var order = ["r", "n", "b", "q", "k", "b", "n", "r"];
    for (var i = 0; i < 8; i++) {
      placement[FILES[i] + back] = order[i];
      placement[FILES[i] + pawns] = "p";
    }
    renderSetup();
  }

  // =====================================================================
  //  GAME SCREEN
  // =====================================================================
  function renderGame(state) {
    // turn indicator
    var ti = $("turnIndicator");
    if (state.yourTurn) { ti.textContent = "Your move"; ti.className = "turnBar you"; }
    else { ti.textContent = "Opponent's move…"; ti.className = "turnBar opp"; }

    // check banner
    var cb = $("checkBanner");
    if (state.inCheck) {
      cb.textContent = "You are in check!";
      cb.classList.remove("hidden");
      checkSquare = state.checkSquare || null;
    } else {
      cb.classList.add("hidden");
      checkSquare = null;
    }

    renderBoard($("gameBoard"), state.board, false);
    renderMoveLog($("moveLog"), state.moveLog);
    renderPinList();
  }

  // board = filtered 64-key object (playing) OR full board (reveal when revealed=true)
  function renderBoard(container, board, revealed) {
    container.innerHTML = "";
    var squares = orderedSquares(yourColor);
    squares.forEach(function (s) {
      var cell = makeCell(s);
      var cellVal = board ? board[s] : null;

      // highlights
      if (lastMove && (lastMove.from === s || lastMove.to === s)) cell.classList.add("lastmove");
      if (!revealed && checkSquare === s) cell.classList.add("checksq");
      if (!revealed && selectedSquare === s) cell.classList.add("selected");

      // move hints
      if (!revealed) {
        var hint = moveHintFor(s);
        if (hint) {
          cell.classList.add("movehint");
          if (cellVal) cell.classList.add("occupied");
        }
      }

      // contents
      if (cellVal) {
        if (revealed) {
          cell.appendChild(pieceSpan(cellVal.type, cellVal.color, false));
        } else if (cellVal.type) {
          // own piece
          cell.appendChild(pieceSpan(cellVal.type, cellVal.color, false));
          if (!revealed) cell.classList.add("selectable");
        } else if (cellVal.occupied) {
          // opponent — fog: never a real type
          cell.appendChild(unknownMarker());
          if (pins[s]) cell.appendChild(pinTagEl(pins[s]));
          cell.classList.add("selectable");
        }
      }

      if (!revealed) {
        cell.addEventListener("click", function () { onSquareClick(s, cellVal); });
      }
      container.appendChild(cell);
    });
  }

  function pinTagEl(guess) {
    var tag = el("span", "pinTag");
    tag.textContent = PIN_LETTER[guess] || guess;
    tag.title = "Your guess: " + guess;
    return tag;
  }

  function moveHintFor(s) {
    for (var i = 0; i < currentMoves.length; i++) {
      if (currentMoves[i].to === s) return currentMoves[i];
    }
    return null;
  }

  function onSquareClick(s, cellVal) {
    if (!lastState || lastState.phase !== "playing") return;

    // clicking a highlighted destination -> make the move
    var dest = moveHintFor(s);
    if (dest && selectedSquare) {
      if (dest.promotion) {
        promoPending = { from: selectedSquare, to: s };
        $("promoModal").classList.remove("hidden");
      } else {
        sendMove(selectedSquare, s, null);
      }
      return;
    }

    // clicking an opponent (occupied) square -> pin picker (allowed any time)
    if (cellVal && cellVal.occupied) {
      openPinModal(s);
      return;
    }

    // clicking own piece on your turn -> request legal moves
    if (cellVal && cellVal.type && lastState.yourTurn) {
      selectedSquare = s;
      currentMoves = [];
      socket.emit("requestMoves", { square: s });
      renderGame(lastState);
      return;
    }

    // otherwise clear selection
    selectedSquare = null;
    currentMoves = [];
    renderGame(lastState);
  }

  function sendMove(from, to, promotion) {
    socket.emit("makeMove", { from: from, to: to, promotion: promotion });
    selectedSquare = null;
    currentMoves = [];
    if (lastState) renderGame(lastState);
  }

  function renderMoveLog(listEl, log) {
    listEl.innerHTML = "";
    (log || []).forEach(function (entry) {
      var li = el("li", entry.own ? "own" : "opp");
      if (entry.capture) li.classList.add("cap");
      var ply = el("span", "ply");
      ply.textContent = entry.ply + ".";
      var txt = el("span");
      txt.textContent = entry.text;
      li.appendChild(ply);
      li.appendChild(txt);
      listEl.appendChild(li);
    });
    listEl.scrollTop = listEl.scrollHeight;
  }

  // =====================================================================
  //  PINS (client-side only; never emitted)
  // =====================================================================
  function openPinModal(s) {
    pinTargetSquare = s;
    $("pinSquareLabel").textContent = s;
    $("pinFreeText").value = (pins[s] && !PIN_LETTER[pins[s]]) ? pins[s] : "";
    $("pinModal").classList.remove("hidden");
  }
  function closePinModal() { $("pinModal").classList.add("hidden"); pinTargetSquare = null; }

  function savePin(guess) {
    if (!pinTargetSquare) return;
    pins[pinTargetSquare] = guess;
    closePinModal();
    if (lastState) renderGame(lastState);
  }

  function renderPinList() {
    var ul = $("pinList");
    ul.innerHTML = "";
    var keys = Object.keys(pins);
    if (!keys.length) {
      var li = el("li");
      li.textContent = "No pins yet.";
      ul.appendChild(li);
      return;
    }
    keys.sort().forEach(function (s) {
      var li = el("li");
      var name = el("span", "sqName");
      name.textContent = s;
      var g = el("span");
      g.textContent = pins[s];
      li.appendChild(name);
      li.appendChild(g);
      ul.appendChild(li);
    });
  }

  // Auto-fade: after each new board, drop pins whose square is no longer an
  // opponent-occupied cell.
  function reconcilePins(newBoard) {
    Object.keys(pins).forEach(function (s) {
      var cell = newBoard[s];
      var stillOpp = cell && cell.occupied === true;
      if (!stillOpp) {
        // brief fade if the tag is on screen, then drop
        var node = document.querySelector('#gameBoard .sq[data-square="' + s + '"] .pinTag');
        if (node) node.classList.add("fade");
        delete pins[s];
      }
    });
  }

  // =====================================================================
  //  END SCREEN
  // =====================================================================
  function renderEnd(over) {
    var resultTxt = {
      checkmate: "Checkmate", stalemate: "Stalemate", draw: "Draw",
      resign: "Resignation", opponentLeft: "Opponent left"
    };
    var title = resultTxt[over.result] || "Game over";
    var reasonLine = "";
    if (over.winner) {
      var youWon = over.winner === yourColor;
      title = (youWon ? "You win" : "You lose") + " — " + title;
    } else {
      title = title + " — draw";
    }
    $("endResult").textContent = title;
    reasonLine = "Reason: " + (over.reason || over.result);
    if (over.fen) reasonLine += "   |   FEN: " + over.fen;
    $("endReason").textContent = reasonLine;

    // Normally a full reveal (both colors' real types) from gameOver.fullBoard.
    // Fallback path passes a filtered board with revealed:false so the fog holds.
    var endBoard = over.fullBoard || over.board;
    var endRevealed = over.revealed !== false && !!over.fullBoard;
    renderBoard($("endBoard"), endBoard, endRevealed);
    if (lastState) renderMoveLog($("endMoveLog"), lastState.moveLog);
    $("rematchStatus").textContent = "";
  }

  // =====================================================================
  //  SOCKET EVENTS  (listen)
  // =====================================================================
  socket.on("connect", function () { setScreen("lobby"); $("lobbyMsg").textContent = "Connected. Waiting…"; });
  socket.on("disconnect", function () { toast("Disconnected from server", true); });

  socket.on("assigned", function (d) {
    yourColor = d.color;
    var badge = $("youAre");
    badge.textContent = "You are " + (d.role || (d.color === "w" ? "white" : "black"));
    badge.className = "badge " + d.color;
    badge.classList.remove("hidden");
  });

  socket.on("rejected", function (d) {
    setScreen("rejected");
    $("rejectedMsg").textContent = d && d.reason === "full"
      ? "Match is full — two players are already connected." : "Connection rejected.";
  });

  socket.on("waiting", function (d) {
    $("lobbyMsg").textContent = (d && d.message) || "Waiting for opponent to connect";
  });

  socket.on("arrangementAccepted", function () {
    $("setupStatus").className = "statusLine ok";
    $("setupStatus").textContent = "Arrangement locked in. Waiting for opponent to be ready…";
    $("readyBtn").disabled = true;
  });

  socket.on("arrangementRejected", function (d) {
    $("setupStatus").className = "statusLine err";
    $("setupStatus").textContent = "Rejected: " + ((d && d.reason) || "invalid arrangement");
    $("readyBtn").disabled = Object.keys(placement).length !== 16;
  });

  socket.on("gameStart", function () { /* authoritative playing `state` follows */ });

  socket.on("legalMoves", function (d) {
    if (!d || d.square !== selectedSquare) return;
    currentMoves = d.moves || [];
    if (lastState) renderGame(lastState);
    if (!d.hasMoves) toast("No legal moves for that piece");
  });

  socket.on("moveMade", function (d) {
    // used purely to flash the from->to transition; log comes from `state`
    if (!d) return;
    lastMove = { from: d.from, to: d.to };
    pendingFlash = { from: d.from, to: d.to };
    // the authoritative `state` (next event) re-renders the board and will
    // apply the persistent .lastmove highlight + trigger the flash animation.
  });

  socket.on("errorMsg", function (d) { toast((d && d.message) || "Illegal move", true); });

  socket.on("check", function (d) {
    if (d && d.inCheck) {
      checkSquare = d.checkSquare || null;
      var cb = $("checkBanner");
      cb.textContent = "You are in check!";
      cb.classList.remove("hidden");
    }
  });

  socket.on("capture", function (d) {
    if (!d) return;
    var who = d.capturedColor === yourColor ? "your" : "opponent's";
    toast("Captured " + (TYPE_NAME[d.capturedType] || d.capturedType) + " (" + who + ") on " + d.square);
  });

  socket.on("state", function (state) {
    lastState = state;
    if (state.yourColor) yourColor = state.yourColor;

    // pin auto-fade based on board diff (only meaningful in playing/ended)
    if (state.board) {
      reconcilePins(state.board);
      prevBoard = state.board;
    }

    switch (state.phase) {
      case "lobby":
        setScreen("lobby");
        $("lobbyMsg").textContent = state.opponentConnected
          ? "Opponent connected. Starting…" : "Waiting for opponent to connect";
        break;
      case "setup":
        // fresh setup (first time or after rematch): reset local setup artefacts
        if (document.body.getAttribute("data-screen") !== "setup") {
          resetForNewGame();
        }
        setScreen("setup");
        if (state.yourReady) {
          $("setupStatus").className = "statusLine ok";
          $("setupStatus").textContent = state.opponentReady
            ? "Both ready — starting…" : "Waiting for opponent to be ready…";
        }
        break;
      case "playing":
        // reset selection each authoritative snapshot
        if (!state.yourTurn) { selectedSquare = null; currentMoves = []; }
        setScreen("game");
        renderGame(state);
        if (pendingFlash) { flashSquares(pendingFlash.from, pendingFlash.to); pendingFlash = null; }
        break;
      case "ended":
        // gameOver event carries the full reveal; if it already ran we stay on end.
        if (document.body.getAttribute("data-screen") !== "end") {
          // fallback if gameOver not yet received: render the FILTERED board
          // (revealed:false) so opponent cells stay {occupied:true} and never hit
          // the reveal path. The gameOver event that follows does the full reveal.
          if (state.result) renderEnd(Object.assign({ board: state.board, revealed: false }, state.result));
          setScreen("end");
        }
        break;
    }
  });

  socket.on("gameOver", function (over) {
    renderEnd(over);
    setScreen("end");
  });

  socket.on("rematchPending", function (d) {
    var msg = (d && d.by === yourColor)
      ? "Waiting for opponent to accept rematch…"
      : "Opponent wants a rematch.";
    $("rematchStatus").textContent = msg;
  });

  // ---------- flash animation for a move ----------
  function flashSquares(from, to) {
    [from, to].forEach(function (s) {
      var cell = document.querySelector('#gameBoard .sq[data-square="' + s + '"]');
      if (cell) {
        cell.classList.remove("flash");
        void cell.offsetWidth; // reflow to restart animation
        cell.classList.add("flash");
      }
    });
  }

  function resetForNewGame() {
    placement = {};
    pins = {};
    prevBoard = null;
    selectedSquare = null;
    currentMoves = [];
    lastMove = null;
    checkSquare = null;
    $("setupStatus").className = "statusLine";
    $("setupStatus").textContent = "";
    renderSetup();
  }

  // =====================================================================
  //  DOM WIRING (emit)
  // =====================================================================
  $("readyBtn").addEventListener("click", function () {
    if (Object.keys(placement).length !== 16) return;
    socket.emit("submitArrangement", { placement: placement });
    $("setupStatus").className = "statusLine";
    $("setupStatus").textContent = "Submitting…";
  });
  $("autoFillBtn").addEventListener("click", standardSetup);
  $("clearSetupBtn").addEventListener("click", function () { placement = {}; renderSetup(); });

  $("resignBtn").addEventListener("click", function () {
    if (confirm("Resign the game? This counts as a loss.")) socket.emit("resign", {});
  });

  $("rematchBtn").addEventListener("click", function () {
    socket.emit("rematch", {});
    $("rematchStatus").textContent = "Waiting for opponent to accept rematch…";
  });

  // promotion modal
  Array.prototype.forEach.call(document.querySelectorAll(".promoBtn"), function (b) {
    b.addEventListener("click", function () {
      if (promoPending) {
        sendMove(promoPending.from, promoPending.to, b.dataset.piece);
        promoPending = null;
      }
      $("promoModal").classList.add("hidden");
    });
  });

  // pin modal
  Array.prototype.forEach.call(document.querySelectorAll(".pinBtn"), function (b) {
    b.addEventListener("click", function () { savePin(b.dataset.guess); });
  });
  $("pinSaveBtn").addEventListener("click", function () {
    var t = $("pinFreeText").value.trim();
    if (t) savePin(t); else closePinModal();
  });
  $("pinClearBtn").addEventListener("click", function () {
    if (pinTargetSquare) { delete pins[pinTargetSquare]; }
    closePinModal();
    if (lastState) renderGame(lastState);
  });
  $("pinCancelBtn").addEventListener("click", closePinModal);

  // initial screen
  setScreen("lobby");
})();
