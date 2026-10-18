// worker/index.js
// Cloudflare adapter for Fog Chess. The Worker serves public/ (assets binding),
// hands out room codes (POST /api/rooms) and passes /ws?room=CODE to the Durable
// Object for that code. Each Durable Object holds ONE match (src/room.js, the
// same code the Node server uses), so every room is its own little server.
//
// The Durable Object uses ws.accept() (not the hibernation API) on purpose: the
// object then stays in memory while players are connected, so the plain
// setTimeout-based timers (60 s seat hold, dead-socket sweep) keep working.
// Match state lives in memory only, like the Node version.

import { DurableObject } from 'cloudflare:workers';
import roomLib from '../src/room.js';

const { Room: MatchRoom, isRoomCode, newRoomCode } = roomLib;

// The Pages sites (fog-chess-game.pages.dev, the older fog-chess-erb.pages.dev, and their preview subdomains) only serve the files and use this
// Worker as its server; other sites may not. Browsers send Origin on fetch and WebSocket requests.
const SITES = ['fog-chess-game.pages.dev', 'fog-chess-erb.pages.dev'];
function allowedOrigin(origin, self) {
  if (!origin || origin === self) return true;
  try {
    const { protocol, hostname } = new URL(origin);
    if (hostname === 'localhost' || hostname === '127.0.0.1') return true;
    return protocol === 'https:' && SITES.some((s) => hostname === s || hostname.endsWith('.' + s));
  } catch { return false; }
}

function withCors(response, origin) {
  if (!origin) return response;
  const r = new Response(response.body, response);
  r.headers.set('Access-Control-Allow-Origin', origin);
  r.headers.set('Vary', 'Origin');
  return r;
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function text(body, status) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain' } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    if ((url.pathname.startsWith('/api/') || url.pathname === '/ws') && !allowedOrigin(origin, url.origin)) {
      return text('Forbidden', 403);
    }

    if (url.pathname === '/api/rooms') {
      if (request.method !== 'POST') return withCors(text('Use POST', 405), origin);
      return withCors(json({ room: newRoomCode() }), origin);
    }

    // Only the Node server knows LAN addresses; online the page's own origin is the link.
    if (url.pathname === '/api/info') {
      return json({ urls: [] });
    }

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return text('Expected a WebSocket', 426);
      const code = url.searchParams.get('room');
      if (!isRoomCode(code)) return text('Bad room code', 400);
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      return stub.fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};

/** One room = one match. Named `Room` to match the wrangler.jsonc binding. */
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.match = null;
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return text('Expected a WebSocket', 426);

    if (!this.match) {
      const match = new MatchRoom({
        onIdle: () => {
          // Everyone left and the reconnect window is over: start clean next time.
          match.dispose();
          if (this.match === match) this.match = null;
        },
      });
      this.match = match;
    }
    const match = this.match;

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    const conn = {
      send(data) {
        server.send(data);
      },
      close(code, reason) {
        server.close(code, reason);
      },
    };
    match.open(conn);
    server.addEventListener('message', (ev) => {
      if (typeof ev.data !== 'string') return;
      match.receive(conn, ev.data);
    });
    server.addEventListener('close', () => match.close(conn));
    server.addEventListener('error', () => match.close(conn));

    return new Response(null, { status: 101, webSocket: client });
  }
}
