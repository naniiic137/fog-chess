/* Fog Chess — frontend client (v2: modes, chaos, house-rules negotiation).
 * Renders strictly from server payloads defined in CONTRACT-v2.md (extends CONTRACT.md).
 *
 * FOG RULE (critical): opponent squares arrive as {occupied:true} ONLY — never a
 * type/color. They render as the neutral hidden token. Real opponent types
 * (standard OR fairy) appear in exactly ONE place: gameOver.fullBoard (the reveal).
 * There is NO code path that renders an opponent type from state.board.
 *
 * Pins are 100% client-side and are never emitted over the socket.
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

  // ---------- client state ----------
  var socket = io();
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

  function autoFill() {
    if (lastState && lastState.mode === "chaos") autoFillGeneric();
    else standardSetupClassic();
  }

  // =====================================================================
  //  GAME SCREEN
  // =====================================================================
  function renderGame(state) {
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

  function renderMoveLog(listEl, log) {
    listEl.innerHTML = "";
    (log || []).forEach(function (entry) {
      var li = el("li", entry.own ? "own" : "opp");
      if (entry.capture) li.classList.add("cap");
      var ply = el("span", "ply");
      ply.textContent = entry.ply + ".";
      var txt = el("span");
      txt.textContent = entry.text; // own = named (incl. fairy); opponent = "unknown piece: …"
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
    Object.keys(pins).forEach(function (s) {
      var cell = newBoard[s];
      var stillOpp = cell && cell.occupied === true;
      if (!stillOpp) {
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
      resign: "Resignation", opponentLeft: "Opponent left",
      kingCaptured: "King captured"
    };
    var title = resultTxt[over.result] || "Game over";
    if (over.winner) {
      var youWon = over.winner === yourColor;
      title = (youWon ? "You win" : "You lose") + " — " + title;
    } else {
      title = title + " — draw";
    }
    $("endResult").textContent = title;

    var reasonLine = "Reason: " + (over.reason || over.result);
    if (over.fen) reasonLine += "   |   FEN: " + over.fen;
    $("endReason").textContent = reasonLine;

    // Full reveal from gameOver.fullBoard (both colors' real types, incl. fairy).
    // Fallback path passes a filtered board with revealed:false so fog holds.
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
    syncDims(state);

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
          ? "Opponent connected. Starting…" : "Waiting for opponent to connect";
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
        if (!screenIs("setup")) resetForNewGame();
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
        if (!screenIs("end")) {
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
    if (pinTargetSquare) { delete pins[pinTargetSquare]; }
    closePinModal();
    if (lastState) renderGame(lastState);
  });
  $("pinCancelBtn").addEventListener("click", closePinModal);

  // initial screen
  setScreen("lobby");
})();
