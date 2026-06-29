// net.js — WebSocket client, session persistence, and auto-rejoin.
//
// Responsibilities:
//   • open a same-origin WebSocket (ws/wss to location.host)
//   • persist { code, playerId, name, token } in localStorage
//   • on open, auto-rejoin a saved session; clear it on room_not_found / kicked
//   • save { playerId, code } when the server acks with `joined`
//   • auto-reconnect with a short backoff, then re-send rejoin
//   • expose: connect, send, onState, onMessage, onOpen, onClose, session helpers
//
// The client is a dumb renderer: it sends intents and renders whatever `state`
// the server returns. No game logic lives here.

const SESSION_KEY = 'pokapoka:session';

// ── Session persistence ──────────────────────────────────────────────────────
//
// Stored in sessionStorage (NOT localStorage) ON PURPOSE: sessionStorage is
// scoped to a single tab/window, so two tabs on the same device never share one
// { code, playerId }. With localStorage they did — and a freshly opened tab
// would auto-rejoin using another tab's playerId on socket open, hijacking that
// seat instead of taking a new one (the "only 2 players can join" bug). A tab's
// sessionStorage still survives socket drops and same-tab reloads, so genuine
// reconnection (network blip / screen lock with the tab alive) keeps working.
function store() {
  try { return window.sessionStorage; } catch { return null; }
}

export function loadSession() {
  try {
    const raw = store()?.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveSession(patch) {
  const next = { ...(loadSession() || {}), ...patch };
  try {
    store()?.setItem(SESSION_KEY, JSON.stringify(next));
  } catch {
    /* storage may be unavailable (private mode) — degrade gracefully */
  }
  return next;
}

export function clearSession() {
  try {
    store()?.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

// ── Network client ───────────────────────────────────────────────────────────

export function createNet() {
  let ws = null;
  let intentionalClose = false;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  const queue = []; // outgoing messages buffered until the socket is open

  const stateHandlers = [];      // (ClientState) => void
  const messageHandlers = new Map(); // type => [fn]
  const openHandlers = [];
  const closeHandlers = [];

  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}`;
  }

  function emit(list, ...args) {
    list.forEach((fn) => {
      try { fn(...args); } catch (e) { console.error('net handler error', e); }
    });
  }

  function connect() {
    intentionalClose = false;
    clearTimeout(reconnectTimer);

    try {
      ws = new WebSocket(wsUrl());
    } catch (e) {
      console.error('WebSocket construction failed', e);
      scheduleReconnect();
      return;
    }

    ws.addEventListener('open', () => {
      reconnectAttempts = 0;
      emit(openHandlers);

      // If the user is starting a fresh table (create/join/spectate is queued),
      // honor that and skip the stale-session auto-rejoin so they don't collide.
      const hasFreshIntent = queue.some((m) => /"type":"(?:create|join|spectate)"/.test(m));
      if (!hasFreshIntent) {
        const s = loadSession();
        if (s && s.code && s.playerId) {
          try { ws.send(JSON.stringify({ type: 'rejoin', code: s.code, playerId: s.playerId })); }
          catch (e) { console.error('rejoin send failed', e); }
        }
      }
      flushQueue();
    });

    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (!msg || typeof msg.type !== 'string') return;

      // Persist the id the server tells us to rejoin with.
      if (msg.type === 'joined' && msg.playerId) {
        saveSession({ playerId: msg.playerId, code: msg.code });
      }

      // A dead/expired session must be dropped so we land back on Home.
      if (msg.type === 'error'
          && (msg.code === 'room_not_found' || msg.code === 'kicked' || msg.code === 'player_not_found')) {
        clearSession();
      }

      // Fan out: `state` to state handlers, everything by-type to message handlers.
      if (msg.type === 'state') emit(stateHandlers, msg.state ?? msg);
      const byType = messageHandlers.get(msg.type);
      if (byType) emit(byType, msg);
    });

    ws.addEventListener('close', () => {
      emit(closeHandlers);
      if (!intentionalClose) scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      // `close` will follow; reconnection is handled there.
    });
  }

  function scheduleReconnect() {
    reconnectAttempts += 1;
    // Backoff: 0.5s, 1s, 2s, … capped at 8s.
    const delay = Math.min(8000, 500 * 2 ** (reconnectAttempts - 1));
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, delay);
  }

  function flushQueue() {
    while (queue.length && ws && ws.readyState === WebSocket.OPEN) {
      const data = queue.shift();
      try { ws.send(data); } catch (e) { console.error('send failed', e); }
    }
  }

  function send(type, payload = {}) {
    const data = JSON.stringify({ type, ...payload });
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(data); return true; } catch (e) { console.error('send failed', e); return false; }
    }
    // Socket not open yet — buffer the intent and make sure we're (re)connecting.
    queue.push(data);
    if (!ws || ws.readyState === WebSocket.CLOSED) connect();
    return true;
  }

  function disconnect() {
    intentionalClose = true;
    clearTimeout(reconnectTimer);
    if (ws) ws.close();
  }

  // Subscription helpers (each returns an unsubscribe fn).
  function onState(cb) { stateHandlers.push(cb); return () => remove(stateHandlers, cb); }
  function onOpen(cb) { openHandlers.push(cb); return () => remove(openHandlers, cb); }
  function onClose(cb) { closeHandlers.push(cb); return () => remove(closeHandlers, cb); }
  function onMessage(type, cb) {
    if (!messageHandlers.has(type)) messageHandlers.set(type, []);
    messageHandlers.get(type).push(cb);
    return () => remove(messageHandlers.get(type), cb);
  }

  function remove(list, cb) {
    const i = list.indexOf(cb);
    if (i >= 0) list.splice(i, 1);
  }

  return {
    connect,
    disconnect,
    send,
    onState,
    onMessage,
    onOpen,
    onClose,
    isOpen: () => !!ws && ws.readyState === WebSocket.OPEN,
    // re-exported for convenience
    loadSession,
    saveSession,
    clearSession,
  };
}
