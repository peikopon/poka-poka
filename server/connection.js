// Poka-Poka — per-socket lifecycle: parse, validate, dispatch, heartbeat.

import { S2C, ERR, isClientMessage } from './protocol.js';

const MAX_MSG_BYTES = 8 * 1024;

export function handleConnection(socket, manager) {
  // ctx travels with the socket; rooms.js fills roomCode/playerId on join.
  const ctx = { socket, roomCode: null, playerId: null };

  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });

  socket.on('message', (data) => {
    if (data.length > MAX_MSG_BYTES) return;
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return send(socket, S2C.ERROR, { code: ERR.BAD_MESSAGE });
    }
    if (!isClientMessage(msg)) return send(socket, S2C.ERROR, { code: ERR.BAD_MESSAGE });
    try {
      manager.handleMessage(ctx, msg);
    } catch (err) {
      console.error('handler error', err);
      send(socket, S2C.ERROR, { code: ERR.BAD_MESSAGE, message: 'Server error' });
    }
  });

  socket.on('close', () => manager.handleDisconnect(ctx));
  socket.on('error', () => { /* close will follow */ });
}

// ping every interval; terminate sockets that didn't pong since the last sweep.
export function startHeartbeat(wss, intervalMs = 20000) {
  const timer = setInterval(() => {
    for (const socket of wss.clients) {
      if (socket.isAlive === false) { socket.terminate(); continue; }
      socket.isAlive = false;
      try { socket.ping(); } catch { /* ignore */ }
    }
  }, intervalMs);
  wss.on('close', () => clearInterval(timer));
  return timer;
}

function send(socket, type, payload = {}) {
  if (socket.readyState === 1) socket.send(JSON.stringify({ type, ...payload }));
}
