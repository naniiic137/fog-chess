/* Fog Chess — tiny WebSocket client with a socket.io-like API.
 *
 *   var socket = FogNet.connect(url, { auth: function () { return { token: ... }; } });
 *   socket.on("state", fn);                 // server events
 *   socket.on("connect", fn);               // (re)connected and `hello` sent
 *   socket.on("disconnect", fn(reason));    // "transport" (will retry) or "server" (won't)
 *   socket.emit("makeMove", data, ack?);    // ack(d) runs when the server answers
 *
 * Wire format: JSON text frames { t: event, d: data, id?: ackId }; acks come back
 * as { ack: id, d: data }. On every (re)connect the first frame is `hello` with
 * the result of `auth()` (the seat token), so a dropped connection resumes the
 * same seat. Reconnects use exponential backoff; the server closing with a code
 * in 4000-4999 (rejected / replaced) stops reconnecting.
 */
(function () {
  "use strict";

  var PING_MS = 15000;      // heartbeat: keeps proxies from closing an idle socket
  var SILENT_MS = 40000;    // nothing heard for this long -> assume dead, reconnect
  var BACKOFF_MIN = 500;
  var BACKOFF_MAX = 8000;

  function connect(url, opts) {
    opts = opts || {};
    var handlers = {};
    var acks = {};
    var nextAck = 1;
    var ws = null;
    var open = false;
    var stopped = false;
    var attempt = 0;
    var retryTimer = null;
    var pingTimer = null;
    var lastHeard = 0;

    function fire(event, data) {
      var list = handlers[event];
      if (!list) return;
      list.slice().forEach(function (fn) {
        try { fn(data); } catch (e) { setTimeout(function () { throw e; }); }
      });
    }

    function send(obj) {
      if (!open) return false;
      try { ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
    }

    function scheduleRetry() {
      if (stopped || retryTimer) return;
      var delay = Math.min(BACKOFF_MAX, BACKOFF_MIN * Math.pow(2, attempt));
      delay = delay / 2 + Math.random() * delay / 2; // jitter
      attempt++;
      retryTimer = setTimeout(function () { retryTimer = null; start(); }, delay);
    }

    function stopPing() {
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = null;
    }

    function closed(sock, code) {
      if (ws !== sock) return;
      var wasOpen = open;
      open = false;
      ws = null;
      acks = {};
      stopPing();
      var final = code >= 4000 && code <= 4999;
      if (final) stopped = true;
      if (wasOpen || final) fire("disconnect", final ? "server" : "transport");
      scheduleRetry();
    }

    function start() {
      if (stopped) return;
      var sock;
      try { sock = new WebSocket(url); } catch (e) { scheduleRetry(); return; }
      ws = sock;

      sock.onopen = function () {
        if (ws !== sock) return;
        open = true;
        attempt = 0;
        lastHeard = Date.now();
        send({ t: "hello", d: typeof opts.auth === "function" ? opts.auth() : (opts.auth || {}) });
        stopPing();
        pingTimer = setInterval(function () {
          if (Date.now() - lastHeard > SILENT_MS) {
            // A half-open socket may never fire onclose: give up on it now.
            try { sock.close(); } catch (e) {}
            closed(sock, 1006);
            return;
          }
          send({ t: "ping", d: null, id: nextAck++ });
        }, PING_MS);
        fire("connect");
      };

      sock.onmessage = function (ev) {
        if (ws !== sock) return;
        lastHeard = Date.now();
        var msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (!msg || typeof msg !== "object") return;
        if (msg.ack !== undefined) {
          var fn = acks[msg.ack];
          delete acks[msg.ack];
          if (fn) fn(msg.d);
          return;
        }
        if (typeof msg.t === "string") fire(msg.t, msg.d);
      };

      sock.onclose = function (ev) { closed(sock, ev && ev.code); };

      sock.onerror = function () { /* onclose follows */ };
    }

    // Phones drop sockets in the background: try again right away when we're back.
    function retryNow() {
      if (stopped || open) return;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      if (!ws) { attempt = 0; start(); }
    }
    window.addEventListener("online", retryNow);
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") retryNow();
    });

    start();

    return {
      on: function (event, fn) { (handlers[event] = handlers[event] || []).push(fn); },
      emit: function (event, data, ack) {
        var msg = { t: event, d: data === undefined ? null : data };
        if (typeof ack === "function") { msg.id = nextAck++; acks[msg.id] = ack; }
        if (!send(msg) && msg.id) delete acks[msg.id];
      },
      connected: function () { return open; },
      close: function () {
        stopped = true;
        if (retryTimer) clearTimeout(retryTimer);
        stopPing();
        if (ws) { try { ws.close(); } catch (e) {} }
      }
    };
  }

  window.FogNet = { connect: connect };
})();
