// Where the game server lives. The Cloudflare Pages site (*.pages.dev) only serves these files,
// so it talks to the Worker; everywhere else (npm start, wrangler dev, the Worker) it's this same site.
window.GAME_SERVER = location.hostname.endsWith('.pages.dev') ? 'https://fog-chess.hamza-benismail-6.workers.dev' : '';
