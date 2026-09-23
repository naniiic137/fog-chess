/* Fog Chess — frontend client (v2: modes, chaos, house-rules negotiation).
 * Renders strictly from server payloads defined in CONTRACT-v2.md (extends CONTRACT.md).
 *
 * FOG RULE (critical): opponent squares arrive as {occupied:true} ONLY — never a
 * type/color. They render as the neutral hidden token. Real opponent types
 * (standard OR fairy) appear in exactly ONE place: gameOver.fullBoard (the reveal).
 * There is NO code path that renders an opponent type from state.board.
 *
 * Pins are 100% client-side and are never emitted over the socket.
 *
 * RECONNECTION: the server issues a seat token on `assigned`. It is kept in
 * sessionStorage (this tab, survives reloads) and localStorage (survives closing
 * the tab) and sent back in the socket.io handshake, so a reload or a dropped
 * connection resumes the same seat within the server's reconnect window.
 */
(function () {
  "use strict";

  // ---------- piece catalog (frontend needs name + class + letter only) ----------
  var STD_TYPES = ["p", "r", "n", "b", "q", "k"];
  var FAIRY_TYPES = ["a", "c", "h", "i", "m", "w"];
  var FAIRY_SET = { a: 1, c: 1, h: 1, i: 1, m: 1, w: 1 };

  var GLYPH = {
    w: { k: "♔", q: "♕", r: "♖", b: "♗", n: "♘", p: "♙" },
    b: { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" }
  };
  var TYPE_NAME = {
    p: "Pawn", n: "Knight", b: "Bishop", r: "Rook", q: "Queen", k: "King",
    a: "Amazon", c: "Chancellor", h: "Archbishop", i: "Nightrider", m: "Camel", w: "Wizard"
  };
  var STD_ROSTER = { p: 8, r: 2, n: 2, b: 2, q: 1, k: 1 };
  var CLASSIC_PRESET = {
    mode: "classic", boardDims: { cols: 8, rows: 8 },
    bannedTypes: [], roster: { p: 8, r: 2, n: 2, b: 2, q: 1, k: 1 }, enabledFairy: []
  };
  // tray/roster display order: standard first (king..pawn) then fairy
  var STD_TRAY_ORDER = ["q", "k", "r", "b", "n", "p"];
  var ROSTER_EDIT_ORDER = ["k", "q", "r", "b", "n", "p"];
  var DIM_CHOICES = [{ cols: 8, rows: 8 }, { cols: 10, rows: 8 }, { cols: 10, rows: 10 }];
  var PIN_LETTER = { Pawn: "P", Knight: "N", Bishop: "B", Rook: "R", Queen: "Q", King: "K" };

  function isFairy(t) { return FAIRY_SET[t] === 1; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  // ---------- seat token (reconnection) ----------
  var TOKEN_KEY = "fogChessToken";
  function storageGet(store, key) { try { return window[store].getItem(key); } catch (e) { return null; } }
  function storageSet(store, key, val) { try { window[store].setItem(key, val); } catch (e) {} }
  function storageDel(store, key) { try { window[store].removeItem(key); } catch (e) {} }

  // Token from this tab (may take over its own stale socket) or, failing that,
  // the last one this browser used (only resumes a seat that is currently away).
  function handshakeAuth() {
    var own = storageGet("sessionStorage", TOKEN_KEY);
    if (own) return { token: own, takeover: true };
    var shared = storageGet("localStorage", TOKEN_KEY);
    if (shared) return { token: shared, takeover: false };
    return {};
  }

  // ---------- client state ----------
  var socket = io({ auth: function (cb) { cb(handshakeAuth()); } });
  var yourColor = null;          // "w" | "b"
  var lastState = null;          // last authoritative `state`
  var dims = { cols: 8, rows: 8 };// current board dims (drives all geometry)
  var setupInfo = null;          // state.setup block during setup phase
  var promotionTypes = ["q", "r", "b", "n"]; // choices offered on promotion
  var prevBoard = null;          // previous filtered board (for pin auto-fade)
  var pins = {};                 // { square: "Queen" | "free text" }
  var placement = {};            // setup: { square: pieceType }
  var selectedTrayType = null;   // setup: piece type "in hand" (click-to-place)
  var selectedSquare = null;     // playing: currently selected own square
  var currentMoves = [];         // legalMoves entries for selectedSquare
  var lastMove = null;           // { from, to } for highlight
  var checkSquare = null;        // square to outline when in check (classic only)
  var promoPending = null;       // { from, to } awaiting promotion choice
  var pinTargetSquare = null;    // square being edited in pin modal
  var pendingFlash = null;       // { from, to } to flash after next render

  var pinsGameId = null;         // server gameId the current `pins` belong to
  var awayDeadline = null;       // local ms timestamp when an away opponent forfeits
  var awayTimer = null;
  var connectionLost = false;    // our own socket is down (auto-reconnecting)
  var endKey = null;             // identifies the end screen currently rendered

  // config negotiation state
  var cfgState = null;           // { config, agreed, version, valid, error }
  var draftConfig = null;        // local editable config (mirrors shared proposal)

  // ---------- tiny DOM helpers ----------
  function $(id) { return document.getElementById(id); }
  function el(tag, cls) { var e = document.createElement(tag); if (cls) e.className = cls; return e; }
  function setScreen(name) { document.body.setAttribute("data-screen", name); }
  function screenIs(name) { return document.body.getAttribute("data-screen") === name; }

  var toastTimer = null;
  function toast(msg, isErr) {
    var t = $("toast");
    t.textContent = msg;
    t.className = "toast" + (isErr ? " err" : "");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.add("hidden"); }, 2600);
  }

  // ---------- coordinates / geometry (generalized to boardDims) ----------
  var SQ_RE = /^([a-z])([0-9]{1,2})$/;
  function fileIndex(letter) { return letter.charCodeAt(0) - 97; }   // 'a'->0 ... 'j'->9
  function fileLetter(idx) { return String.fromCharCode(97 + idx); }
  function fileOf(s) { var m = SQ_RE.exec(s); return m ? m[1] : s.charAt(0); }
  function rankOf(s) { var m = SQ_RE.exec(s); return m ? parseInt(m[2], 10) : parseInt(s.slice(1), 10); }
  function sq(file, rank) { return file + rank; }

  function filesFor(d) { var o = []; for (var i = 0; i < d.cols; i++) o.push(fileLetter(i)); return o; }
  function ranksFor(d) { var o = []; for (var r = 1; r <= d.rows; r++) o.push(r); return o; }

  function isLight(s) {
    // parity identical to v1 for classic (fileIndex('a')=0, rank 1..8)
    return (fileIndex(fileOf(s)) + rankOf(s)) % 2 === 1;
  }

  // Board squares in DISPLAY order (top-left -> bottom-right), viewer at bottom.
  // White: ranks high..low, files a..last.  Black: ranks low..high, files reversed.
  function orderedSquares(color, d) {
    d = d || dims;
    var out = [];
    var ranks = ranksFor(d);
    var files = filesFor(d);
    var rankSeq = color === "b" ? ranks.slice() : ranks.slice().reverse();
    for (var r = 0; r < rankSeq.length; r++) {
      var fileSeq = color === "b" ? files.slice().reverse() : files.slice();
      for (var f = 0; f < fileSeq.length; f++) out.push(sq(fileSeq[f], rankSeq[r]));
    }
    return out;
  }

  function applyDims(container, d) {
    container.style.gridTemplateColumns = "repeat(" + d.cols + ", 1fr)";
    container.style.gridTemplateRows = "repeat(" + d.rows + ", 1fr)";
    container.style.aspectRatio = d.cols + " / " + d.rows;
    container.style.setProperty("--cols", d.cols);
    container.style.setProperty("--rows", d.rows);
  }

  // ---------- generic board cell + piece rendering ----------
  function makeCell(s) {
    var cell = el("div", "sq " + (isLight(s) ? "light" : "dark"));
    cell.dataset.square = s;
    var coord = el("span", "coord");
    coord.textContent = s;
    cell.appendChild(coord);
    return cell;
  }

  // Standard piece -> unicode glyph; fairy piece -> distinct colored letter badge.
  // Called ONLY for own pieces (state.board {type,color}) or the reveal (fullBoard).
  function pieceNode(type, color, draggable) {
    if (isFairy(type)) {
      var b = el("span", "piece fairy fairy-" + type + " " + color + (draggable ? " draggable" : ""));
      b.textContent = type.toUpperCase();       // A C H I M W
      b.title = TYPE_NAME[type];
      return b;
    }
    var p = el("span", "piece " + color + (draggable ? " draggable" : ""));
    p.textContent = GLYPH[color][type];
    p.title = TYPE_NAME[type] || "";
    return p;
  }

  function unknownMarker() { return el("div", "unknown"); }

  // =====================================================================
  //  CONFIG / HOUSE-RULES NEGOTIATION SCREEN  (phase "config")
  // =====================================================================
  function yourSide() { return yourColor === "b" ? "black" : "white"; }

  function cleanConfig(cfg) {
    if (!cfg || cfg.mode === "classic") return clone(CLASSIC_PRESET);
    var banned = (cfg.bannedTypes || []).slice();
    var enabled = (cfg.enabledFairy || []).slice();
    var roster = {};
    var src = cfg.roster || {};
    Object.keys(src).forEach(function (t) {
      if (banned.indexOf(t) !== -1) return;
      if (isFairy(t) && enabled.indexOf(t) === -1) return;
      if (src[t] > 0) roster[t] = src[t];
    });
    return {
      mode: "chaos",
      boardDims: { cols: cfg.boardDims.cols, rows: cfg.boardDims.rows },
      bannedTypes: banned,
      roster: roster,
      enabledFairy: enabled
    };
  }

  // client-side mirror of CONTRACT-v2 B.6 validity (server is authoritative)
  function validateLocal(cfg) {
    if (!cfg || cfg.mode === "classic") return { valid: true, error: null };
    var roster = cfg.roster || {};
    if (!(roster.k > 0)) return { valid: false, error: "At least one king is required." };
    var total = 0;
    Object.keys(roster).forEach(function (t) { total += roster[t]; });
    if (total < 1) return { valid: false, error: "Roster is empty." };
    var cols = cfg.boardDims.cols, rows = cfg.boardDims.rows;
    var N = Math.max(2, Math.ceil(total / cols));
    if (2 * N > rows) {
      return {
        valid: false,
        error: "Roster too large for a " + rows + "-tall board (needs " + N + " home ranks per side)."
      };
    }
    return { valid: true, error: null };
  }

  function seedConfigFromState(state) {
    var v = state.configVersion;
    if (!cfgState || cfgState.version !== v) {
      cfgState = {
        config: state.config ? clone(state.config) : clone(CLASSIC_PRESET),
        agreed: state.agreed ? clone(state.agreed) : { white: false, black: false },
        version: v,
        valid: true,
        error: null
      };
    } else {
      if (state.agreed) cfgState.agreed = clone(state.agreed);
      if (state.config) cfgState.config = clone(state.config);
    }
    draftConfig = clone(cfgState.config);
  }

  // Any local edit: mutate the draft, tidy it, emit proposeConfig, optimistically
  // reflect the agreement RESET locally (server bumps version + clears both agrees).
  function applyEditAndPush(mutator) {
    mutator(draftConfig);
    draftConfig = cleanConfig(draftConfig);
    socket.emit("proposeConfig", { config: draftConfig });
    var v = validateLocal(draftConfig);
    if (cfgState) {
      cfgState.config = clone(draftConfig);
      cfgState.agreed = { white: false, black: false }; // edit resets agreement
      cfgState.valid = v.valid;
      cfgState.error = v.error;
    }
    renderConfig();
  }

  function renderConfig() {
    if (!draftConfig || !cfgState) return;
    var isChaos = draftConfig.mode === "chaos";

    // mode toggle
    $("modeClassic").classList.toggle("active", !isChaos);
    $("modeChaos").classList.toggle("active", isChaos);
    $("modeDesc").textContent = isChaos
      ? "Chaos: king-capture wins, custom armies, fairy pieces and variable boards. No check."
      : "Classic: standard chess rules with fog of war (the original game).";
    $("chaosOptions").style.display = isChaos ? "" : "none";

    if (isChaos) {
      renderDimsPicker();
      renderFairyToggles();
      renderRosterEditor();
    }

    renderConfigSummary();

    var youAgreed = !!cfgState.agreed[yourSide()];
    var oppAgreed = !!cfgState.agreed[yourColor === "b" ? "white" : "black"];
    var chipYou = $("agreedYou");
    chipYou.textContent = "You: " + (youAgreed ? "agreed ✓" : "not agreed");
    chipYou.className = "agreeChip" + (youAgreed ? " ok" : "");
    var chipOpp = $("agreedOpp");
    chipOpp.textContent = "Opponent: " + (oppAgreed ? "agreed ✓" : "not agreed");
    chipOpp.className = "agreeChip" + (oppAgreed ? " ok" : "");

    var err = $("cfgError");
    if (cfgState.valid === false && cfgState.error) {
      err.textContent = cfgState.error;
      err.style.display = "";
    } else {
      err.textContent = "";
      err.style.display = "none";
    }

    $("cfgVersion").textContent = "Proposal v" + cfgState.version;

    var btn = $("agreeBtn");
    btn.disabled = youAgreed || cfgState.valid === false;
    btn.textContent = youAgreed ? "Agreed ✓" : "Agree to these rules";
  }

  function renderDimsPicker() {
    var box = $("dimsPicker");
    box.innerHTML = "";
    DIM_CHOICES.forEach(function (dc) {
      var active = draftConfig.boardDims.cols === dc.cols && draftConfig.boardDims.rows === dc.rows;
      var b = el("button", "dimBtn" + (active ? " active" : ""));
      b.textContent = dc.cols + "×" + dc.rows;
      b.addEventListener("click", function () {
        applyEditAndPush(function (d) { d.boardDims = { cols: dc.cols, rows: dc.rows }; });
      });
      box.appendChild(b);
    });
  }

  function renderFairyToggles() {
    var box = $("fairyToggles");
    box.innerHTML = "";
    FAIRY_TYPES.forEach(function (t) {
      var on = draftConfig.enabledFairy.indexOf(t) !== -1;
      var chip = el("button", "fairyChip fairy-" + t + (on ? " on" : ""));
      var badge = el("span", "fairyChipBadge fairy-" + t);
      badge.textContent = t.toUpperCase();
      chip.appendChild(badge);
      var lbl = el("span");
      lbl.textContent = TYPE_NAME[t];
      chip.appendChild(lbl);
      chip.addEventListener("click", function () {
        applyEditAndPush(function (d) {
          var idx = d.enabledFairy.indexOf(t);
          if (idx !== -1) { d.enabledFairy.splice(idx, 1); delete d.roster[t]; }
          else { d.enabledFairy.push(t); if (!(d.roster[t] > 0)) d.roster[t] = 0; }
        });
      });
      box.appendChild(chip);
    });
  }

  function renderRosterEditor() {
    var box = $("rosterEditor");
    box.innerHTML = "";
    var types = ROSTER_EDIT_ORDER.slice();
    FAIRY_TYPES.forEach(function (t) { if (draftConfig.enabledFairy.indexOf(t) !== -1) types.push(t); });

    types.forEach(function (t) {
      var banned = draftConfig.bannedTypes.indexOf(t) !== -1;
      var count = banned ? 0 : (draftConfig.roster[t] || 0);
      var isKing = t === "k";

      var row = el("div", "rosterRow" + (banned ? " banned" : ""));

      var ico = el("span", "rosterIcon");
      ico.appendChild(pieceNode(t, yourColor || "w", false));
      row.appendChild(ico);

      var name = el("span", "rosterName");
      name.textContent = TYPE_NAME[t];
      row.appendChild(name);

      var stepper = el("div", "stepper");
      var minus = el("button", "stepBtn");
      minus.textContent = "−";
      minus.disabled = banned || (isKing ? count <= 1 : count <= 0);
      minus.addEventListener("click", function () {
        applyEditAndPush(function (d) {
          var min = isKing ? 1 : 0;
          var c = Math.max(min, (d.roster[t] || 0) - 1);
          if (c > 0) d.roster[t] = c; else delete d.roster[t];
        });
      });
      var cnt = el("span", "stepCount");
      cnt.textContent = count;
      var plus = el("button", "stepBtn");
      plus.textContent = "+";
      plus.disabled = banned;
      plus.addEventListener("click", function () {
        applyEditAndPush(function (d) { d.roster[t] = (d.roster[t] || 0) + 1; });
      });
      stepper.appendChild(minus);
      stepper.appendChild(cnt);
      stepper.appendChild(plus);
      row.appendChild(stepper);

      var banLbl = el("label", "banToggle");
      var banCb = el("input");
      banCb.type = "checkbox";
      banCb.checked = banned;
      banCb.disabled = isKing; // can't ban all kings
      banCb.addEventListener("change", function () {
        applyEditAndPush(function (d) {
          var idx = d.bannedTypes.indexOf(t);
          if (idx !== -1) d.bannedTypes.splice(idx, 1);
          else { d.bannedTypes.push(t); delete d.roster[t]; }
        });
      });
      banLbl.appendChild(banCb);
      var banTxt = el("span");
      banTxt.textContent = "ban";
      banLbl.appendChild(banTxt);
      row.appendChild(banLbl);

      box.appendChild(row);
    });
  }

  function renderConfigSummary() {
    var box = $("cfgSummary");
    box.innerHTML = "";
    var cfg = draftConfig;
    var head = el("div", "cfgSumHead");
    if (cfg.mode === "classic") {
      head.textContent = "Classic · standard army · 8×8";
      box.appendChild(head);
      return;
    }
    head.textContent = "Chaos · " + cfg.boardDims.cols + "×" + cfg.boardDims.rows;
    box.appendChild(head);

    var total = 0;
    Object.keys(cfg.roster).forEach(function (t) { total += cfg.roster[t]; });
    var line = el("div", "cfgSumLine");
    var parts = [];
    ROSTER_EDIT_ORDER.concat(FAIRY_TYPES).forEach(function (t) {
      if (cfg.roster[t] > 0) parts.push(cfg.roster[t] + t.toUpperCase());
    });
    line.textContent = parts.join("  ") + "   (" + total + " pieces / side)";
    box.appendChild(line);

    if (cfg.bannedTypes.length) {
      var ban = el("div", "cfgSumBan");
      ban.textContent = "Banned: " + cfg.bannedTypes.map(function (t) { return TYPE_NAME[t]; }).join(", ");
      box.appendChild(ban);
    }
  }

  // =====================================================================
  //  SETUP SCREEN  (roster/home-region driven)
  // =====================================================================
  function getSetupInfo(state) {
    if (state && state.setup) return state.setup;
    return {
      roster: clone(STD_ROSTER),
      boardDims: { cols: 8, rows: 8 },
      homeRanks: yourColor === "b" ? [7, 8] : [1, 2],
      bannedTypes: [], enabledFairy: [], promotionTypes: ["q", "r", "b", "n"]
    };
  }

  function homeRanksArr() { return (setupInfo && setupInfo.homeRanks) || (yourColor === "b" ? [7, 8] : [1, 2]); }
  function isHomeSquare(s) { return homeRanksArr().indexOf(rankOf(s)) !== -1; }
  function rosterObj() { return (setupInfo && setupInfo.roster) || STD_ROSTER; }
  function rosterTotal() {
    var r = rosterObj(), n = 0;
    Object.keys(r).forEach(function (t) { n += r[t]; });
    return n;
  }
  function trayOrder() {
    var r = rosterObj(), out = [];
    STD_TRAY_ORDER.forEach(function (t) { if ((r[t] || 0) > 0) out.push(t); });
    FAIRY_TYPES.forEach(function (t) { if ((r[t] || 0) > 0) out.push(t); });
    return out;
  }

  function renderSetup() {
    var board = $("setupBoard");
    board.innerHTML = "";
    var ranks = homeRanksArr();
    applyDims(board, { cols: dims.cols, rows: ranks.length });

    // player's home squares only, oriented viewer-at-bottom
    var squares = orderedSquares(yourColor, dims).filter(isHomeSquare);
    squares.forEach(function (s) {
      var cell = makeCell(s);
      cell.classList.add("dropTargetZone", "selectable");
      cell.addEventListener("click", function () { onSetupSquareClick(s); });
      cell.addEventListener("dragover", function (ev) { ev.preventDefault(); cell.classList.add("dropTarget"); });
      cell.addEventListener("dragleave", function () { cell.classList.remove("dropTarget"); });
      cell.addEventListener("drop", function (ev) { onDropToSquare(ev, s, cell); });
      if (placement[s]) {
        var p = pieceNode(placement[s], yourColor, true);
        p.setAttribute("draggable", "true");
        p.addEventListener("dragstart", function (ev) {
          ev.dataTransfer.setData("text/plain", JSON.stringify({ origin: s, type: placement[s] }));
        });
        p.addEventListener("click", function (ev) { ev.stopPropagation(); onSetupSquareClick(s); });
        p.title = "Click to remove (or replace with the piece in hand)";
        cell.appendChild(p);
      }
      board.appendChild(cell);
    });

    // castling / pawn rules for this mode
    var rules = $("setupRules");
    if (rules) {
      var chaosMode = lastState && lastState.mode === "chaos";
      var back = yourColor === "b" ? 8 : 1;
      rules.innerHTML = chaosMode
        ? "Chaos mode has <b>no castling</b>. A pawn on your back rank moves one square at a time until it reaches your 2nd rank."
        : "<b>Castling</b> is allowed when your king starts on e" + back + " and a rook on a" + back +
          " or h" + back + " (as in <i>Standard setup</i>); the usual rules apply. " +
          "A pawn on your back rank moves one square at a time until it reaches your 2nd rank.";
    }

    // dynamic hint about number of home ranks
    var hint = $("setupHint");
    if (hint) {
      var nR = ranks.length;
      hint.innerHTML = "Click a piece in the tray to pick it up, then click any of your <b>" +
        nR + " home rank" + (nR === 1 ? "" : "s") +
        "</b> to place it. Click a placed piece to remove it. Dragging works too — " +
        "full freedom within your home region.";
    }

    renderTray();
    updateReady();
    updateInHand();
    saveSetupDraft();
  }

  // Keep the in-progress arrangement across a reload (this tab only).
  function setupDraftKey() {
    return "fogSetup:" + (lastState ? lastState.configVersion : "") + ":" + yourColor;
  }
  function saveSetupDraft() {
    storageSet("sessionStorage", setupDraftKey(), JSON.stringify(placement));
  }
  function loadSetupDraft() {
    var raw = storageGet("sessionStorage", setupDraftKey());
    if (!raw) return {};
    try {
      var obj = JSON.parse(raw) || {};
      var out = {};
      Object.keys(obj).forEach(function (s) { if (isHomeSquare(s) && typeof obj[s] === "string") out[s] = obj[s]; });
      return out;
    } catch (e) { return {}; }
  }

  function onSetupSquareClick(s) {
    if (!isHomeSquare(s)) return;
    if (selectedTrayType) {
      if (remaining(selectedTrayType) <= 0 && placement[s] !== selectedTrayType) {
        toast("No more " + TYPE_NAME[selectedTrayType] + " left", true);
        return;
      }
      placement[s] = selectedTrayType;
      if (remaining(selectedTrayType) <= 0) selectedTrayType = null;
      renderSetup();
    } else if (placement[s]) {
      delete placement[s];
      renderSetup();
    }
  }

  function updateInHand() {
    var box = $("inHand");
    if (!box) return;
    if (selectedTrayType) {
      box.innerHTML = "";
      box.appendChild(document.createTextNode("In hand: "));
      var strong = el("b");
      strong.appendChild(pieceNode(selectedTrayType, yourColor, false));
      strong.appendChild(document.createTextNode(" " + TYPE_NAME[selectedTrayType]));
      box.appendChild(strong);
      box.appendChild(document.createTextNode(
        " — click a square to place. (" + remaining(selectedTrayType) + " left)"));
    } else {
      box.textContent = "Click a tray piece to pick it up.";
    }
  }

  function placedCounts() {
    var c = {};
    for (var s in placement) { c[placement[s]] = (c[placement[s]] || 0) + 1; }
    return c;
  }
  function remaining(type) {
    var used = placedCounts()[type] || 0;
    return (rosterObj()[type] || 0) - used;
  }

  function renderTray() {
    var tray = $("tray");
    tray.innerHTML = "";
    trayOrder().forEach(function (type) {
      var rem = remaining(type);
      var item = el("div", "trayItem" + (rem <= 0 ? " empty" : "") +
        (selectedTrayType === type ? " selected" : ""));
      var g = el("span", "trayGlyph");
      g.appendChild(pieceNode(type, yourColor, false));
      item.appendChild(g);
      var cnt = el("span", "count");
      cnt.textContent = "x" + rem;
      item.appendChild(cnt);
      item.title = TYPE_NAME[type];
      if (rem > 0) {
        item.setAttribute("draggable", "true");
        item.addEventListener("dragstart", function (ev) {
          ev.dataTransfer.setData("text/plain", JSON.stringify({ origin: "tray", type: type }));
        });
        item.addEventListener("click", function () {
          selectedTrayType = (selectedTrayType === type) ? null : type;
          renderSetup();
        });
      } else if (selectedTrayType === type) {
        selectedTrayType = null;
      }
      tray.appendChild(item);
    });
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
    if (!isHomeSquare(target)) return;

    if (data.origin === "tray") {
      if (remaining(data.type) <= 0 && placement[target] !== data.type) {
        toast("No more " + TYPE_NAME[data.type] + " in tray", true);
        return;
      }
      placement[target] = data.type;
    } else {
      var moving = placement[data.origin];
      if (moving === undefined) return;
      var occupant = placement[target];
      placement[target] = moving;
      if (occupant !== undefined && data.origin !== target) placement[data.origin] = occupant;
      else delete placement[data.origin];
    }
    renderSetup();
  }

  function removeFromSquare(s) { delete placement[s]; renderSetup(); }

  function updateReady() {
    var n = Object.keys(placement).length;
    var total = rosterTotal();
    $("trayCount").textContent = n + " / " + total + " placed";
    $("readyBtn").disabled = n !== total;
    // relabel auto-fill by mode
    var af = $("autoFillBtn");
    if (af) af.textContent = (lastState && lastState.mode === "chaos") ? "Auto-fill" : "Standard setup";
  }

  // Classic exact standard arrangement (unchanged from v1).
  function standardSetupClassic() {
    placement = {};
    var files = filesFor({ cols: 8, rows: 8 });
    var back = yourColor === "w" ? 1 : 8;
    var pawns = yourColor === "w" ? 2 : 7;
    var order = ["r", "n", "b", "q", "k", "b", "n", "r"];
    for (var i = 0; i < 8; i++) {
      placement[files[i] + back] = order[i];
      placement[files[i] + pawns] = "p";
    }
    renderSetup();
  }

  // Generic auto-fill for any roster/home region: back rank first, files left->right.
  function autoFillGeneric() {
    placement = {};
    var r = rosterObj();
    var pieces = [];
    ROSTER_EDIT_ORDER.forEach(function (t) { for (var i = 0; i < (r[t] || 0); i++) pieces.push(t); });
    FAIRY_TYPES.forEach(function (t) { for (var j = 0; j < (r[t] || 0); j++) pieces.push(t); });
    // home squares ordered back-rank-first (viewer's own back rank), files a..last
    var ranks = homeRanksArr().slice().sort(function (a, b) { return a - b; });
    var seq = yourColor === "w" ? ranks : ranks.slice().reverse(); // white: low->high, black: high->low
    var files = filesFor(dims);
    var home = [];
    seq.forEach(function (rk) { files.forEach(function (fl) { home.push(fl + rk); }); });
    for (var k = 0; k < pieces.length && k < home.length; k++) placement[home[k]] = pieces[k];
    renderSetup();
  }

  function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  // Random arrangement: pieces shuffled onto the back rank(s), pawns in front.
  function randomizeSetup() {
    placement = {};
    var r = rosterObj();
    var officers = [], pawns = [];
    Object.keys(r).forEach(function (t) {
      for (var i = 0; i < r[t]; i++) (t === "p" ? pawns : officers).push(t);
    });
    var ranks = homeRanksArr().slice().sort(function (a, b) { return a - b; });
    var seq = yourColor === "w" ? ranks : ranks.slice().reverse(); // own back rank first
    var squares = [];
    seq.forEach(function (rk) {
      shuffle(filesFor(dims).slice()).forEach(function (fl) { squares.push(fl + rk); });
    });
    var pieces = shuffle(officers).concat(pawns);
    for (var k = 0; k < pieces.length && k < squares.length; k++) placement[squares[k]] = pieces[k];
    selectedTrayType = null;
    renderSetup();
  }

  function autoFill() {
    if (lastState && lastState.mode === "chaos") autoFillGeneric();
    else standardSetupClassic();
  }

  // =====================================================================
  //  GAME SCREEN
  // =====================================================================
  function renderGame(state) {
    if (state.lastMove) lastMove = state.lastMove;
    var ti = $("turnIndicator");
    if (state.yourTurn) { ti.textContent = "Your move"; ti.className = "turnBar you"; }
    else { ti.textContent = "Opponent's move…"; ti.className = "turnBar opp"; }

    // check banner — classic only; chaos always inCheck=false
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

  // board = filtered board (playing) OR full reveal board (revealed=true, gameOver only)
  function renderBoard(container, board, revealed) {
    container.innerHTML = "";
    applyDims(container, dims);
    var squares = orderedSquares(yourColor, dims);
    squares.forEach(function (s) {
      var cell = makeCell(s);
      var cellVal = board ? board[s] : null;

      if (lastMove && (lastMove.from === s || lastMove.to === s)) cell.classList.add("lastmove");
      if (!revealed && checkSquare === s) cell.classList.add("checksq");
      if (!revealed && selectedSquare === s) cell.classList.add("selected");

      if (!revealed) {
        var hint = moveHintFor(s);
        if (hint) {
          cell.classList.add("movehint");
          if (cellVal) cell.classList.add("occupied");
        }
      }

      if (cellVal) {
        if (revealed) {
          // reveal path: show every real type (both colors), incl. fairy badges
          cell.appendChild(pieceNode(cellVal.type, cellVal.color, false));
        } else if (cellVal.type) {
          // own piece (standard glyph or fairy badge)
          cell.appendChild(pieceNode(cellVal.type, cellVal.color, false));
          cell.classList.add("selectable");
        } else if (cellVal.occupied) {
          // opponent — FOG: only the neutral hidden token, never a type/badge/glyph
          cell.appendChild(unknownMarker());
          if (pins[s]) cell.appendChild(pinTagEl(pins[s]));
          cell.classList.add("selectable");
        }
      }

      if (!revealed) cell.addEventListener("click", function () { onSquareClick(s, cellVal); });
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
    for (var i = 0; i < currentMoves.length; i++) if (currentMoves[i].to === s) return currentMoves[i];
    return null;
  }

  function onSquareClick(s, cellVal) {
    if (!lastState || lastState.phase !== "playing") return;

    var dest = moveHintFor(s);
    if (dest && selectedSquare) {
      if (dest.promotion) {
        promoPending = { from: selectedSquare, to: s };
        renderPromoChoices();
        $("promoModal").classList.remove("hidden");
      } else {
        sendMove(selectedSquare, s, null);
      }
      return;
    }

    if (cellVal && cellVal.occupied) { openPinModal(s); return; }

    if (cellVal && cellVal.type && lastState.yourTurn) {
      selectedSquare = s;
      currentMoves = [];
      socket.emit("requestMoves", { square: s });
      renderGame(lastState);
      return;
    }

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

  // promotion choices come from state.setup.promotionTypes (may include a fairy letter)
  function renderPromoChoices() {
    var box = $("promoChoices");
    box.innerHTML = "";
    var choices = (promotionTypes && promotionTypes.length) ? promotionTypes : ["q", "r", "b", "n"];
    choices.forEach(function (t) {
      var b = el("button", "promoBtn");
      b.appendChild(pieceNode(t, yourColor, false));
      var lbl = el("span", "promoLbl");
      lbl.textContent = TYPE_NAME[t] || t;
      b.appendChild(lbl);
      b.addEventListener("click", function () {
        if (promoPending) { sendMove(promoPending.from, promoPending.to, t); promoPending = null; }
        $("promoModal").classList.add("hidden");
      });
      box.appendChild(b);
    });
  }

  // Moves paired per full move ("1.  White  Black"). Text comes from the server:
  // own moves are named, opponent moves read "Hidden piece d7→d5" until the game
  // ends, when every move is named.
  function renderMoveLog(box, log) {
    box.innerHTML = "";
    var head = el("div", "logRow logHead");
    head.appendChild(el("span", "logNum"));
    ["w", "b"].forEach(function (c) {
      var h = el("span", "logCell");
      h.textContent = (c === "w" ? "White" : "Black") + (c === yourColor ? " (you)" : "");
      head.appendChild(h);
    });
    box.appendChild(head);

    var entries = log || [];
    if (!entries.length) {
      var empty = el("div", "logEmpty");
      empty.textContent = "No moves yet.";
      box.appendChild(empty);
      return;
    }
    var rows = {};
    entries.forEach(function (entry) {
      var n = Math.ceil(entry.ply / 2);
      if (!rows[n]) rows[n] = { w: null, b: null };
      rows[n][entry.color === "b" ? "b" : "w"] = entry;
    });
    Object.keys(rows).map(Number).sort(function (a, b) { return a - b; }).forEach(function (n) {
      var row = el("div", "logRow");
      var num = el("span", "logNum");
      num.textContent = n + ".";
      row.appendChild(num);
      ["w", "b"].forEach(function (c) {
        var entry = rows[n][c];
        var cell = el("span", "logCell");
        if (entry) {
          cell.classList.add(entry.own ? "own" : "opp");
          if (entry.revealed) cell.classList.add("revealed");
          if (entry.capture) cell.classList.add("cap");
          cell.textContent = entry.text;
        }
        row.appendChild(cell);
      });
      box.appendChild(row);
    });
    box.scrollTop = box.scrollHeight;
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
    storePins();
    closePinModal();
    if (lastState) renderGame(lastState);
  }

  // Pins survive a reload of this tab (scoped to the server's gameId).
  function storePins() {
    if (pinsGameId !== null) storageSet("sessionStorage", "fogPins:" + pinsGameId, JSON.stringify(pins));
  }
  function loadPins(gameId) {
    var raw = storageGet("sessionStorage", "fogPins:" + gameId);
    try { return raw ? (JSON.parse(raw) || {}) : {}; } catch (e) { return {}; }
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
      var row = el("li");
      var name = el("span", "sqName");
      name.textContent = s;
      var g = el("span");
      g.textContent = pins[s];
      row.appendChild(name);
      row.appendChild(g);
      ul.appendChild(row);
    });
  }

  function reconcilePins(newBoard) {
    var changed = false;
    Object.keys(pins).forEach(function (s) {
      var cell = newBoard[s];
      var stillOpp = cell && cell.occupied === true;
      if (!stillOpp) {
        var node = document.querySelector('#gameBoard .sq[data-square="' + s + '"] .pinTag');
        if (node) node.classList.add("fade");
        delete pins[s];
        changed = true;
      }
    });
    if (changed) storePins();
  }

  // =====================================================================
  //  END SCREEN
  // =====================================================================
  function graceSeconds() {
    var ms = lastState && lastState.reconnectGraceMs;
    return Math.round((typeof ms === "number" ? ms : 60000) / 1000);
  }

  // Plain-sentence result for the viewer: { title, detail, tone }.
  function describeResult(over) {
    var won = over.winner ? over.winner === yourColor : null;
    var chaosMode = lastState && lastState.mode === "chaos";
    var secs = graceSeconds();
    var title = won === null ? "Draw" : (won ? "You won!" : "You lost");
    var detail;
    switch (over.reason || over.result) {
      case "checkmate":
        detail = won ? "Checkmate: your opponent's king had no way out." : "Checkmate: your king had no way out.";
        break;
      case "kingCaptured":
        detail = won ? "You captured your opponent's last king." : "Your last king was captured.";
        break;
      case "resign":
        detail = won ? "Your opponent resigned." : "You resigned.";
        break;
      case "abandoned":
      case "opponentLeft":
        detail = won
          ? "Your opponent disconnected and did not come back within " + secs + " seconds."
          : "You were disconnected for more than " + secs + " seconds, so the game was forfeited.";
        break;
      case "stalemate":
        detail = chaosMode
          ? "The player to move had no legal moves, so the game is a draw."
          : "Stalemate: the player to move had no legal moves but was not in check.";
        break;
      case "threefold":
        detail = "The same position came up three times.";
        break;
      case "fiftyMoves":
      case "moveLimit":
        detail = "Fifty moves each went by without a capture or a pawn move.";
        break;
      case "insufficientMaterial":
        detail = "Neither side has enough pieces left to checkmate.";
        break;
      default:
        detail = won === null ? "The game ended in a draw." : "The game is over.";
    }
    return { title: title, detail: detail, tone: won === null ? "draw" : (won ? "win" : "loss") };
  }

  // Renders the result + full reveal. `over` is the gameOver payload (also
  // carried by an ended `state`, so a reload still gets the unfogged board).
  function renderEnd(over, moveLog) {
    var d = describeResult(over);
    var h = $("endResult");
    h.textContent = d.title;
    h.className = "endTitle " + d.tone;
    $("endReason").textContent = d.detail;

    var fenBtn = $("copyFenBtn");
    fenBtn.classList.toggle("hidden", !over.fen);
    fenBtn.dataset.fen = over.fen || "";
    fenBtn.textContent = "Copy position";

    // Full reveal from gameOver.fullBoard (both colors' real types, incl. fairy).
    // Fallback path passes a filtered board with revealed:false so fog holds.
    var endBoard = over.fullBoard || over.board;
    var endRevealed = over.revealed !== false && !!over.fullBoard;
    renderBoard($("endBoard"), endBoard, endRevealed);
    var log = moveLog || (lastState && lastState.moveLog);
    if (log) renderMoveLog($("endMoveLog"), log);
  }

  function showEnd(over, moveLog) {
    var key = (lastState && lastState.gameId) + ":" + over.result + ":" + over.winner;
    var firstTime = !screenIs("end") || endKey !== key;
    renderEnd(over, moveLog);
    if (firstTime) {
      endKey = key;
      $("rematchStatus").textContent = "";
      Sound.end(over.winner ? over.winner === yourColor : null);
    }
    setScreen("end");
  }

  function copyText(text, onDone) {
    function fallback() {
      var ta = el("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) {}
      document.body.removeChild(ta);
      onDone(ok);
    }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () { onDone(true); }, fallback);
    } else {
      fallback();
    }
  }

  // =====================================================================
  //  CONNECTION + OPPONENT-AWAY BANNER
  // =====================================================================
  function updateNetBanner() {
    var b = $("netBanner");
    var msg = "";
    if (connectionLost) {
      msg = "Connection lost — reconnecting… Your seat is kept for " + graceSeconds() + " seconds.";
    } else if (awayDeadline !== null) {
      var left = Math.max(0, Math.ceil((awayDeadline - Date.now()) / 1000));
      var playing = lastState && lastState.phase === "playing";
      msg = "Opponent disconnected — waiting " + left + " s for them to come back." +
        (playing ? " If they don't, you win." : "");
    }
    b.textContent = msg;
    b.classList.toggle("hidden", !msg);
    document.body.classList.toggle("has-banner", !!msg);
    b.classList.toggle("err", connectionLost);
  }

  function syncAway(state) {
    var away = typeof state.opponentAwayMs === "number" && state.phase !== "lobby" && state.phase !== "ended";
    awayDeadline = away ? Date.now() + state.opponentAwayMs : null;
    if (awayDeadline !== null && !awayTimer) {
      awayTimer = setInterval(updateNetBanner, 500);
    } else if (awayDeadline === null && awayTimer) {
      clearInterval(awayTimer);
      awayTimer = null;
    }
    updateNetBanner();
  }

  // =====================================================================
  //  JOIN LINK + QR (waiting screen)
  // =====================================================================
  var joinInfo = null;
  function isLocalHost(h) { return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1"; }
  function showJoinBox(show) {
    var box = $("joinBox");
    if (!show) { box.classList.add("hidden"); return; }
    function fill() {
      var urls = (joinInfo && joinInfo.urls) || [];
      var url = location.origin;
      var others = [];
      if (isLocalHost(location.hostname) && urls.length) {
        url = urls[0];
        others = urls.slice(1);
      }
      var a = $("joinUrl");
      a.textContent = url;
      a.href = url;
      var qr = "/qr.svg?text=" + encodeURIComponent(url);
      if ($("joinQr").getAttribute("src") !== qr) $("joinQr").setAttribute("src", qr);
      $("joinOther").textContent = others.length ? "Other addresses: " + others.join("  ·  ") : "";
      box.classList.remove("hidden");
    }
    if (joinInfo) { fill(); return; }
    fetch("/api/info").then(function (r) { return r.json(); })
      .then(function (info) { joinInfo = info; fill(); })
      .catch(function () { joinInfo = { urls: [] }; fill(); });
  }

  // =====================================================================
  //  SOUND (synthesised with Web Audio; no audio files)
  // =====================================================================
  var Sound = (function () {
    var ctx = null;
    var muted = storageGet("localStorage", "fogMuted") === "1";
    function ac() {
      if (muted) return null;
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      if (!ctx) { try { ctx = new AC(); } catch (e) { return null; } }
      if (ctx.state === "suspended") ctx.resume();
      return ctx;
    }
    function tone(freq, start, dur, type, vol) {
      var c = ac();
      if (!c) return;
      var t0 = c.currentTime + start;
      var o = c.createOscillator();
      var g = c.createGain();
      o.type = type || "sine";
      o.frequency.setValueAtTime(freq, t0);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol || 0.2, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g); g.connect(c.destination);
      o.start(t0); o.stop(t0 + dur + 0.02);
    }
    return {
      isMuted: function () { return muted; },
      setMuted: function (m) { muted = m; storageSet("localStorage", "fogMuted", m ? "1" : "0"); },
      unlock: function () { ac(); },
      move: function () { tone(660, 0, 0.07, "triangle", 0.18); tone(440, 0.05, 0.08, "triangle", 0.12); },
      capture: function () { tone(220, 0, 0.16, "square", 0.12); tone(150, 0.06, 0.2, "sine", 0.2); },
      notify: function () { tone(880, 0, 0.12, "sine", 0.14); },
      end: function (won) {
        var notes = won === true ? [523, 659, 784] : (won === false ? [392, 330, 262] : [440, 440]);
        notes.forEach(function (f, i) { tone(f, i * 0.14, 0.22, "sine", 0.18); });
      }
    };
  })();

  function renderSoundBtn() {
    var b = $("soundBtn");
    var on = !Sound.isMuted();
    b.innerHTML = on
      ? '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M4 9v6h4l5 4V5L8 9H4z"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12"/></svg>'
      : '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M4 9v6h4l5 4V5L8 9H4z"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M16.5 9.5l5 5M21.5 9.5l-5 5"/></svg>';
    b.setAttribute("aria-pressed", on ? "true" : "false");
    b.setAttribute("aria-label", on ? "Sound on" : "Sound off");
    b.title = on ? "Sound on (click to mute)" : "Sound off (click to unmute)";
  }

  // =====================================================================
  //  SOCKET EVENTS  (listen)
  // =====================================================================
  socket.on("connect", function () {
    if (connectionLost) { connectionLost = false; updateNetBanner(); }
    if (!lastState) { setScreen("lobby"); $("lobbyMsg").textContent = "Connected. Waiting…"; }
  });
  socket.on("disconnect", function (reason) {
    // "io server disconnect" = we were retired (another tab took the seat);
    // anything else auto-reconnects with our token.
    if (reason === "io server disconnect") return;
    connectionLost = true;
    updateNetBanner();
  });

  socket.on("assigned", function (d) {
    if (d.token) {
      storageSet("sessionStorage", TOKEN_KEY, d.token);
      storageSet("localStorage", TOKEN_KEY, d.token);
    }
    if (d.resumed && lastState) toast("Reconnected");
    yourColor = d.color;
    var badge = $("youAre");
    badge.textContent = "You are " + (d.role || (d.color === "w" ? "white" : "black"));
    badge.className = "badge " + d.color;
    badge.classList.remove("hidden");
  });

  socket.on("rejected", function (d) {
    var reason = d && d.reason;
    setScreen("rejected");
    connectionLost = false;
    awayDeadline = null;
    updateNetBanner();
    if (reason === "replaced") {
      // Another tab of this browser took the seat over; don't reclaim it from here.
      storageDel("sessionStorage", TOKEN_KEY);
      $("rejectedMsg").textContent = "This game is now open in another tab or window. Continue there, or reload this page to try again.";
    } else if (reason === "reconnecting") {
      $("rejectedMsg").textContent = "A game is in progress and one player is reconnecting. Try again in a minute.";
    } else if (reason === "full") {
      $("rejectedMsg").textContent = "Match is full — two players are already connected.";
    } else {
      $("rejectedMsg").textContent = "Connection rejected.";
    }
  });

  socket.on("waiting", function (d) {
    $("lobbyMsg").textContent = (d && d.message) || "Waiting for opponent to connect";
  });

  // house-rules negotiation broadcast (server -> both)
  socket.on("config", function (msg) {
    if (!msg) return;
    cfgState = {
      config: clone(msg.config),
      agreed: clone(msg.agreed || { white: false, black: false }),
      version: msg.version,
      valid: msg.valid,
      error: msg.error || null
    };
    draftConfig = clone(msg.config);
    if (screenIs("config")) renderConfig();
  });

  socket.on("arrangementAccepted", function () {
    $("setupStatus").className = "statusLine ok";
    $("setupStatus").textContent = "Arrangement locked in. Waiting for opponent to be ready…";
    $("readyBtn").disabled = true;
  });

  socket.on("arrangementRejected", function (d) {
    $("setupStatus").className = "statusLine err";
    $("setupStatus").textContent = "Rejected: " + ((d && d.reason) || "invalid arrangement");
    $("readyBtn").disabled = Object.keys(placement).length !== rosterTotal();
  });

  socket.on("gameStart", function () { /* authoritative playing `state` follows */ });

  socket.on("legalMoves", function (d) {
    if (!d || d.square !== selectedSquare) return;
    currentMoves = d.moves || [];
    if (lastState) renderGame(lastState);
    if (!d.hasMoves) toast("No legal moves for that piece");
  });

  socket.on("moveMade", function (d) {
    if (!d) return;
    lastMove = { from: d.from, to: d.to };
    pendingFlash = { from: d.from, to: d.to };
    if (d.entry && d.entry.capture) Sound.capture(); else Sound.move();
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
    var name = (TYPE_NAME[d.capturedType] || d.capturedType || "piece").toLowerCase();
    if (d.capturedColor === yourColor) {
      toast("Your " + name + " on " + d.square + " was captured.");
    } else {
      toast("You captured " + (/^[aeiou]/.test(name) ? "an " : "a ") + name + " on " + d.square + ".");
    }
  });

  socket.on("state", function (state) {
    var prevPhase = lastState && lastState.phase;
    lastState = state;
    if (state.yourColor) yourColor = state.yourColor;
    syncDims(state);
    syncAway(state);
    if (prevPhase && prevPhase !== "lobby" && state.phase === "lobby") {
      toast("Your opponent left. Waiting for a new opponent.");
    }

    // Restore this game's private pins after a reload (before reconciling).
    if (state.gameId !== null && state.gameId !== undefined && state.gameId !== pinsGameId &&
        (state.phase === "playing" || state.phase === "ended")) {
      pinsGameId = state.gameId;
      pins = loadPins(state.gameId);
    }

    // update mode badge
    var mb = $("modeBadge");
    if (state.mode) {
      mb.textContent = state.mode === "chaos" ? "Chaos" : "Classic";
      mb.className = "badge mode-" + state.mode;
      mb.classList.remove("hidden");
    }

    if (state.board) { reconcilePins(state.board); prevBoard = state.board; }

    switch (state.phase) {
      case "lobby":
        setScreen("lobby");
        $("lobbyMsg").textContent = state.opponentConnected
          ? "Opponent connected. Starting…" : "Waiting for your opponent to join…";
        showJoinBox(!state.opponentConnected);
        break;

      case "config":
        if (!screenIs("config")) resetForNewGame();
        seedConfigFromState(state);
        setScreen("config");
        renderConfig();
        break;

      case "setup":
        setupInfo = getSetupInfo(state);
        if (setupInfo.promotionTypes) promotionTypes = setupInfo.promotionTypes.slice();
        if (!screenIs("setup")) {
          resetForNewGame();
          placement = loadSetupDraft();
        }
        setScreen("setup");
        renderSetup();
        if (state.yourReady) {
          $("setupStatus").className = "statusLine ok";
          $("setupStatus").textContent = state.opponentReady
            ? "Both ready — starting…" : "Waiting for opponent to be ready…";
        }
        break;

      case "playing":
        if (!state.yourTurn) { selectedSquare = null; currentMoves = []; }
        setScreen("game");
        renderGame(state);
        if (pendingFlash) { flashSquares(pendingFlash.from, pendingFlash.to); pendingFlash = null; }
        break;

      case "ended":
        if (state.lastMove) lastMove = state.lastMove;
        if (state.gameOver) {
          showEnd(state.gameOver, state.moveLog);
        } else if (state.result) {
          showEnd(Object.assign({ board: state.board, revealed: false }, state.result), state.moveLog);
        }
        break;
    }
  });

  socket.on("gameOver", function (over) {
    showEnd(over);
  });

  socket.on("rematchPending", function (d) {
    var msg = (d && d.by === yourColor)
      ? "Waiting for opponent to accept rematch…"
      : "Opponent wants a rematch.";
    $("rematchStatus").textContent = msg;
  });

  function syncDims(state) {
    var d = null;
    if (state.setup && state.setup.boardDims) d = state.setup.boardDims;
    else if (state.boardDims) d = state.boardDims;
    else if (state.config && state.config.boardDims) d = state.config.boardDims;
    if (d && typeof d.cols === "number" && typeof d.rows === "number") dims = { cols: d.cols, rows: d.rows };
  }

  // ---------- flash animation for a move ----------
  function flashSquares(from, to) {
    [from, to].forEach(function (s) {
      var cell = document.querySelector('#gameBoard .sq[data-square="' + s + '"]');
      if (cell) {
        cell.classList.remove("flash");
        void cell.offsetWidth;
        cell.classList.add("flash");
      }
    });
  }

  function resetForNewGame() {
    placement = {};
    selectedTrayType = null;
    pins = {};
    prevBoard = null;
    selectedSquare = null;
    currentMoves = [];
    lastMove = null;
    checkSquare = null;
    pinsGameId = null;
    endKey = null;
    $("setupStatus").className = "statusLine";
    $("setupStatus").textContent = "";
  }

  // =====================================================================
  //  DOM WIRING (emit)
  // =====================================================================
  // config controls
  $("modeClassic").addEventListener("click", function () {
    applyEditAndPush(function (d) { d.mode = "classic"; });
  });
  $("modeChaos").addEventListener("click", function () {
    applyEditAndPush(function (d) {
      d.mode = "chaos";
      if (!d.roster || !Object.keys(d.roster).length) d.roster = clone(STD_ROSTER);
    });
  });
  $("agreeBtn").addEventListener("click", function () {
    var v = cfgState ? cfgState.version : (lastState ? lastState.configVersion : 0);
    socket.emit("agreeConfig", { version: v });
  });

  // setup controls
  $("readyBtn").addEventListener("click", function () {
    if (Object.keys(placement).length !== rosterTotal()) return;
    socket.emit("submitArrangement", { placement: placement });
    $("setupStatus").className = "statusLine";
    $("setupStatus").textContent = "Submitting…";
  });
  $("autoFillBtn").addEventListener("click", autoFill);
  $("randomBtn").addEventListener("click", randomizeSetup);
  $("clearSetupBtn").addEventListener("click", function () {
    placement = {}; selectedTrayType = null; renderSetup();
  });

  // board display size (local preference; persisted)
  (function initBoardSize() {
    var sel = $("boardSize");
    if (!sel) return;
    var saved = null;
    try { saved = localStorage.getItem("fogBoardSize"); } catch (e) {}
    if (saved) sel.value = saved;
    function apply() {
      document.documentElement.style.setProperty("--board-max", sel.value + "px");
      try { localStorage.setItem("fogBoardSize", sel.value); } catch (e) {}
    }
    sel.addEventListener("change", apply);
    apply();
  })();

  $("resignBtn").addEventListener("click", function () {
    if (confirm("Resign the game? This counts as a loss.")) socket.emit("resign", {});
  });

  $("copyFenBtn").addEventListener("click", function () {
    var btn = $("copyFenBtn");
    copyText(btn.dataset.fen || "", function (ok) {
      btn.textContent = ok ? "Copied!" : "Copy failed";
      toast(ok ? "Position copied as FEN — paste it into any analysis board." : "Could not copy: " + (btn.dataset.fen || ""), !ok);
      setTimeout(function () { btn.textContent = "Copy position"; }, 1800);
    });
  });

  $("copyJoinBtn").addEventListener("click", function () {
    copyText($("joinUrl").textContent, function (ok) {
      toast(ok ? "Link copied" : "Could not copy the link", !ok);
    });
  });

  $("soundBtn").addEventListener("click", function () {
    Sound.setMuted(!Sound.isMuted());
    renderSoundBtn();
    if (!Sound.isMuted()) Sound.notify();
  });
  renderSoundBtn();
  // Browsers only allow audio after a user gesture.
  document.addEventListener("pointerdown", function () { Sound.unlock(); }, { once: true });

  $("rematchBtn").addEventListener("click", function () {
    socket.emit("rematch", {});
    $("rematchStatus").textContent = "Waiting for opponent to accept rematch…";
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
    if (pinTargetSquare) { delete pins[pinTargetSquare]; storePins(); }
    closePinModal();
    if (lastState) renderGame(lastState);
  });
  $("pinCancelBtn").addEventListener("click", closePinModal);

  // initial screen
  setScreen("lobby");
})();
