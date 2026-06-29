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
// No-store so phones/browsers always fetch the latest HTML/JS/CSS/sprite — this
// is a small LAN/casual app with no build hashing, so stale caches (especially
// on "Add to Home Screen") just cause confusion. Cheap to refetch.
const noStore = (res) => res.setHeader('Cache-Control', 'no-store, must-revalidate');
app.use(express.static(path.join(ROOT, 'public'), { setHeaders: noStore, etag: false, lastModified: false }));
app.use('/assets', express.static(path.join(ROOT, 'assets'), { setHeaders: noStore, etag: false, lastModified: false }));

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
