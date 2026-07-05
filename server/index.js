// Poka-Poka — HTTP + WebSocket entry point (Render web service).

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { RoomManager } from './rooms.js';
import { handleConnection, startHeartbeat } from './connection.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 3000;

const app = express();
app.disable('x-powered-by');

// Health check for Render.
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// Static: the front-end and the shared icon sprite.
// Two cache policies:
//  - HTML/JS/CSS → no-store: phones always get the newest code on reload (no
//    build hashing, and "Add to Home Screen" caches aggressively).
//  - voice_pack + icons → cache 1 day: they're ~85% of a visit's bytes and
//    rarely change. The CLIENT requests them with ?v=<ASSET_VERSION> (see
//    public/sound.js) — bump that constant when you replace a sprite/voice
//    and every device re-downloads immediately (new URL = new cache entry;
//    the old one just expires away).
const setCache = (res, filePath) => {
  if (/[\\/](voice_pack|icons)[\\/]/.test(filePath)) {
    res.setHeader('Cache-Control', 'public, max-age=86400');
  } else {
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
  }
};
app.use(express.static(path.join(ROOT, 'public'), { setHeaders: setCache, etag: false, lastModified: false }));
app.use('/assets', express.static(path.join(ROOT, 'assets'), { setHeaders: setCache, etag: false, lastModified: false }));

// SPA fallback → index.html for any non-asset GET.
app.get('*', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  res.sendFile(path.join(ROOT, 'public', 'index.html'));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const manager = new RoomManager();

wss.on('connection', (socket) => handleConnection(socket, manager));
startHeartbeat(wss);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Poka-Poka listening on http://0.0.0.0:${PORT}`);
});
