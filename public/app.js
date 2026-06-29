// app.js — state store, render-from-ClientState, screen routing, action senders.
//
// The client is a dumb renderer. It holds the latest ClientState from the server
// (or a mock fixture) and rebuilds the visible screen from it. All money/turn
// logic is the server's; here we only present and emit intents.

import { createNet } from './net.js';
import { MOCKS } from './mock-state.js';
import { createSound } from './sound.js';

// Empty so icons reference the INLINED sprite (<use href="#id">). The sprite is
// fetched and injected into the page at boot — external-sprite <use> does not
// resolve gradient fills on iOS Safari, which left gradient hats transparent.
const SPRITE = '';

// Token palette (matches the avatar sticker hues / chrome accents).
const TOKEN_COLORS = {
  'avatar-01': '#E2613C', 'avatar-02': '#2C9C8F', 'avatar-03': '#D69A2E',
  'avatar-04': '#5B6CC4', 'avatar-05': '#C85C8E', 'avatar-06': '#4F9D5B',
  'avatar-07': '#6B7785', 'avatar-08': '#8A5BB0', 'avatar-09': '#C0794A',
};
const TOKENS = Object.keys(TOKEN_COLORS);

const SUIT_GLYPH = { s: '♠', h: '♥', d: '♦', c: '♣' };
const SUIT_ICON = { s: 'suit-spade', h: 'suit-heart', d: 'suit-diamond', c: 'suit-club' };
const RED_SUITS = new Set(['h', 'd']);

// Hand-rankings reference (strongest → weakest) for the in-game help drawer.
const HAND_RANKS = [
  { name: 'Royal Flush', desc: 'A K Q J 10, all the same suit.', cards: ['As', 'Ks', 'Qs', 'Js', 'Ts'] },
  { name: 'Straight Flush', desc: 'Five cards in a row, all the same suit.', cards: ['9h', '8h', '7h', '6h', '5h'] },
  { name: 'Four of a Kind', desc: 'Four cards of the same rank.', cards: ['Ks', 'Kh', 'Kd', 'Kc', '3d'] },
  { name: 'Full House', desc: 'Three of a kind plus a pair.', cards: ['Qs', 'Qh', 'Qd', '7c', '7h'] },
  { name: 'Flush', desc: 'Five cards of one suit, not in order.', cards: ['Ad', 'Jd', '8d', '5d', '2d'] },
  { name: 'Straight', desc: 'Five cards in a row, mixed suits.', cards: ['8s', '7h', '6d', '5c', '4s'] },
  { name: 'Three of a Kind', desc: 'Three cards of the same rank.', cards: ['Js', 'Jh', 'Jd', '9c', '2d'] },
  { name: 'Two Pair', desc: 'Two different pairs.', cards: ['As', 'Ah', '8d', '8c', '3s'] },
  { name: 'One Pair', desc: 'One pair of matching cards.', cards: ['Ts', 'Th', 'Ks', '7d', '2c'] },
  { name: 'High Card', desc: 'No combination — the highest card plays.', cards: ['As', 'Qh', '9d', '6c', '3s'] },
];

// ── Module state ──────────────────────────────────────────────────────────────
const net = createNet();
const sound = createSound();
let state = null;          // latest ClientState
let mockMode = null;       // 'lobby' | 'turn' | 'showdown' | null
let currentScreen = 'home';

// transient UI flags
let takenTokens = new Set(); // avatars already used in the room being joined
let actionPending = false; // an action was sent; ignore the bar until next state
let chatUnread = false;    // a chat arrived while the drawer was closed
let prevBoardLen = 0;      // for community-card reveal animation
let prevHandNumber = null; // for hole-card deal animation
let wasMyTurn = false;     // to chime once when it becomes my turn
let prevPhase = null;      // to detect hand-over / game transitions

// pre-game (pre-state) flow scratch
const draft = {
  settings: { ...defaultSettings() },
  intent: null,            // 'host' | 'join'
  code: '',                // join code
  name: '',
  token: 'avatar-01',
};

// action-bar local UI state
let abAmount = 0;          // current "raise to" amount
let abLegalSig = null;     // signature of the legal context the amount belongs to
const log = [];            // client-side action log entries (best-effort)

// ── Boot ──────────────────────────────────────────────────────────────────────
// Inline the icon sprite into the page so <use href="#id"> resolves its gradient
// fills everywhere (external-sprite <use> drops gradients on iOS Safari).
async function injectSprite() {
  try {
    // 'reload' bypasses the HTTP cache so edits to the sprite (card-backs,
    // avatars, icons) always show up — 'force-cache' froze the old sprite.
    const res = await fetch('/assets/icons/poker-icons.svg', { cache: 'reload' });
    const txt = await res.text();
    const host = document.getElementById('sprite-host');
    if (host) host.innerHTML = txt;
    // Static <use> in the HTML was parsed before the sprite existed; re-insert
    // each one so it re-resolves against the now-present symbols.
    document.querySelectorAll('use').forEach((u) => {
      const href = u.getAttribute('href') || u.getAttribute('xlink:href');
      if (href && href.charAt(0) === '#') u.replaceWith(u.cloneNode(true));
    });
  } catch (e) {
    console.error('sprite inline failed', e);
  }
}

async function boot() {
  await injectSprite();

  const params = new URLSearchParams(location.search);
  const mock = params.get('mock');

  buildStaticUI();
  wireEvents();

  if (mock && MOCKS[mock]) {
    // Serverless preview: render a fixture, skip the socket entirely.
    mockMode = mock;
    setConn(true);
    // Expose a tiny hook so the fixture can be re-rendered / swapped during QA.
    window.__pokapoka = { applyState, getState: () => state };
    applyState(MOCKS[mock]);
    return;
  }

  // Live mode.
  net.onState(applyState);
  net.onOpen(() => setConn(true));
  net.onClose(() => setConn(false));
  net.onMessage('error', (m) => {
    actionPending = false; // a rejected action must not leave the bar locked
    // A stale or revoked session is expected on reconnect — handle it quietly.
    if (m.code === 'room_not_found') { goHome(); toast('That table has ended.'); return; }
    if (m.code === 'kicked') { goHome(); toast('You were removed from the table.'); return; }
    if (m.code === 'host_left') { goHome(); toast('The host closed the table.'); return; }
    if (m.code === 'player_not_found') { goHome(); return; } // stale/expired seat → quietly reset
    // Not-your-turn is benign: it just means our UI was a beat stale (e.g. a
    // double-tap, or the turn timer auto-acted). Re-render, don't alarm.
    if (m.code === 'not_your_turn') { render(); return; }
    toast(m.message || 'Something went wrong');
  });
  net.onMessage('chat', (m) => pushChat(m));
  net.onMessage('react', (m) => floatEmote(m.emote));
  // A fresh seat (new join/create) starts with a clean chat history.
  net.onMessage('joined', () => clearChat());
  // Which avatars are already taken in the room we're about to join.
  net.onMessage('roomInfo', (m) => {
    takenTokens = new Set(m.takenTokens || []);
    // If our current pick is taken (or none free chosen), move to a free one.
    if (takenTokens.has(draft.token)) pickFirstFreeToken();
    buildTokenGrid();
  });
  net.connect();

  // If we have a saved session, net auto-rejoins on open; otherwise show Home.
  showScreen('home');
}

// ── Screen routing ─────────────────────────────────────────────────────────────
function showScreen(name) {
  currentScreen = name;
  document.querySelectorAll('.screen').forEach((el) => {
    el.classList.toggle('is-active', el.dataset.screen === name);
  });
  document.body.classList.toggle('on-table', name === 'table');
  if (name === 'identity') enterIdentity();
  if (name === 'join') prefillJoinBoxes();
}

// On the identity screen, refresh which avatars are available. Hosting a new
// table → all free; joining → ask the server which are already taken.
function enterIdentity() {
  updateIdentityContext();
  if (draft.intent === 'join' && draft.code && !mockMode) {
    net.send('peek', { code: draft.code });
  } else {
    takenTokens = new Set();
    buildTokenGrid();
  }
}

function updateIdentityContext() {
  const el = document.getElementById('identity-context');
  if (!el) return;
  el.textContent = draft.intent === 'host'
    ? 'Hosting a new table'
    : `Joining table ${draft.code || '????'}`;
}

// Mirror draft.code back into the join boxes (e.g. when navigating Back).
function prefillJoinBoxes() {
  const boxes = document.querySelectorAll('#join-form .code-box');
  const code = draft.code || '';
  boxes.forEach((b, i) => { b.value = code[i] || ''; b.classList.toggle('is-filled', !!b.value); });
}

// Choose the screen from a ClientState snapshot.
function screenFor(s) {
  if (!s) return 'home';
  const phase = s.room?.phase;
  if (phase === 'lobby') return 'lobby';
  if (phase === 'game-over') return 'results';
  if (phase === 'in-hand' || phase === 'hand-over') return 'table';
  return 'home';
}

// ── State application + render ─────────────────────────────────────────────────
// Animation hints consumed by the next render(), then reset.
let animBoardFrom = -1;  // animate board cards from this index (newly dealt)
let animDealHole = false; // animate the deal of my hole cards

function applyState(s) {
  detectTransitions(s);       // diff against trackers (still holding prev values)
  state = s;                  // commit before rendering
  actionPending = false;      // server has spoken; unlock the action bar
  showScreen(screenFor(s));
  render();
  // reset one-shot animation hints
  animBoardFrom = -1;
  animDealHole = false;
  // update trackers for the next diff
  prevBoardLen = s?.hand?.board?.length || 0;
  if (s?.hand?.handNumber != null) prevHandNumber = s.hand.handNumber;
  prevPhase = s?.room?.phase ?? null;
  wasMyTurn = !!s?.hand?.legal;
}

// Compare the incoming snapshot with the previous one to fire sounds + flag
// card animations.
function detectTransitions(s) {
  const phase = s?.room?.phase;
  const hand = s?.hand;
  const boardLen = hand?.board?.length || 0;

  // New hand → deal animation + shuffle/deal sound.
  if (hand && hand.handNumber != null && hand.handNumber !== prevHandNumber) {
    animDealHole = true;
    prevBoardLen = 0; // a fresh board
    sound.play('deal');
  }
  // Community cards revealed.
  if (boardLen > prevBoardLen) {
    animBoardFrom = prevBoardLen;
    sound.play('deal');
  }
  // It just became my turn.
  if (hand?.legal && !wasMyTurn) sound.play('turn');
  // Hand finished / game finished.
  if (phase === 'hand-over' && prevPhase !== 'hand-over') {
    sound.play(s?.result?.showdown ? 'win' : 'chip');
  }
  if (phase === 'game-over' && prevPhase !== 'game-over') sound.play('win');
}

function render() {
  if (!state) return;
  switch (currentScreen) {
    case 'lobby': renderLobby(); break;
    case 'table': renderTable(); break;
    case 'results': renderResults(); break;
  }
}

/* ════════════════════════════════════════════════════════════════════════════
   STATIC UI — build option lists / token grid once
   ════════════════════════════════════════════════════════════════════════════ */
function buildStaticUI() {
  buildRulesOptions();
  buildTokenGrid();
  buildEmoteWheel();
  buildHelp();
  syncSoundButton();
  // Browsers gate audio until a user gesture — unlock on the first tap.
  window.addEventListener('pointerdown', () => sound.unlock(), { once: true });
}

// Render the scrollable hand-rankings reference into the help drawer.
function buildHelp() {
  const body = document.getElementById('help-body');
  if (!body) return;
  body.innerHTML = `<p class="help-intro">Hands rank strongest → weakest. At showdown the best five-card hand wins.</p>`
    + HAND_RANKS.map((h, i) => `
      <div class="help-rank">
        <div class="help-rank__head">
          <span class="help-rank__no">${i + 1}</span>
          <span class="help-rank__name">${h.name}</span>
        </div>
        <div class="help-rank__cards">${h.cards.map(cardHtml).join('')}</div>
        <div class="help-rank__desc">${h.desc}</div>
      </div>`).join('');
}

function syncSoundButton() {
  const btn = document.getElementById('sound-btn');
  if (!btn) return;
  const on = sound.isOn();
  btn.innerHTML = `<svg width="15" height="15" aria-hidden="true"><use href="#${on ? 'sound-on' : 'sound-off'}"></use></svg>`;
  btn.classList.toggle('is-off', !on);
  btn.setAttribute('aria-label', on ? 'Mute sound' : 'Unmute sound');
}

function defaultSettings() {
  return {
    startingStack: 2500, smallBlind: 5, bigBlind: 10, blindsMode: 'increasing',
    maxSeats: 8, betting: 'no-limit', turnTimer: 30, winCondition: 'last-standing',
  };
}

function buildRulesOptions() {
  // Starting stack
  fillSeg('[data-setting="startingStack"] .seg', [
    { v: 500, t: '500' }, { v: 1000, t: '1,000' }, { v: 2500, t: '2,500' }, { v: 5000, t: '5,000' },
  ], draft.settings.startingStack, (v) => { draft.settings.startingStack = v; });

  // Blinds (value encodes sb/bb)
  fillSeg('[data-setting="blinds"] .seg--quad', [
    { v: '1/2', t: '1/2', sb: 1, bb: 2 },
    { v: '5/10', t: '5/10', sb: 5, bb: 10 },
    { v: '25/50', t: '25/50', sb: 25, bb: 50 },
    { v: '50/100', t: '50/100', sb: 50, bb: 100 },
  ], `${draft.settings.smallBlind}/${draft.settings.bigBlind}`, (_, opt) => {
    draft.settings.smallBlind = opt.sb; draft.settings.bigBlind = opt.bb;
  });

  // Blinds mode
  fillSeg('[data-setting="blindsMode"]', [
    { v: 'increasing', t: 'Increasing' }, { v: 'fixed', t: 'Fixed' },
  ], draft.settings.blindsMode, (v) => { draft.settings.blindsMode = v; });

  // Turn timer
  fillSeg('[data-setting="turnTimer"] .seg', [
    { v: 15, t: '15s' }, { v: 30, t: '30s' }, { v: 60, t: '60s' }, { v: 0, t: 'Off' },
  ], draft.settings.turnTimer, (v) => { draft.settings.turnTimer = v; });

  // Win condition
  fillSeg('[data-setting="winCondition"] .seg', [
    { v: 'last-standing', t: 'Last chips' }, { v: 'host-ends', t: 'Host ends' },
  ], draft.settings.winCondition, (v) => { draft.settings.winCondition = v; });

  // Seats stepper
  document.getElementById('seats-value').textContent = draft.settings.maxSeats;
}

// Populate a segmented control; wires single-select.
function fillSeg(sel, opts, selected, onPick) {
  const seg = document.querySelector(sel);
  if (!seg) return;
  seg.innerHTML = '';
  opts.forEach((opt) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'seg__opt' + (opt.v === selected ? ' is-on' : '');
    b.dataset.value = String(opt.v);
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', opt.v === selected ? 'true' : 'false');
    b.innerHTML = opt.t;
    b.addEventListener('click', () => {
      seg.querySelectorAll('.seg__opt').forEach((o) => {
        o.classList.remove('is-on'); o.setAttribute('aria-checked', 'false');
      });
      b.classList.add('is-on'); b.setAttribute('aria-checked', 'true');
      onPick(opt.v, opt);
    });
    seg.appendChild(b);
  });
}

function buildTokenGrid() {
  const grid = document.getElementById('token-grid');
  grid.innerHTML = '';
  TOKENS.forEach((id) => {
    const isTaken = takenTokens.has(id);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'token'
      + (id === draft.token ? ' is-selected' : '')
      + (isTaken ? ' is-taken' : '');
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', id === draft.token ? 'true' : 'false');
    b.setAttribute('aria-label', isTaken ? `Avatar ${id} (taken)` : `Avatar ${id}`);
    if (isTaken) { b.disabled = true; b.title = 'Taken by another player'; }
    b.innerHTML = svgUse(id);
    b.addEventListener('click', () => selectToken(id));
    grid.appendChild(b);
  });
  updateTokenPreview();
}

// Move the selection to the first avatar that isn't already taken.
function pickFirstFreeToken() {
  const free = TOKENS.find((t) => !takenTokens.has(t));
  if (free) draft.token = free;
}

function selectToken(id) {
  if (takenTokens.has(id)) { toast('That avatar is taken — pick another'); return; }
  draft.token = id;
  document.querySelectorAll('#token-grid .token').forEach((t, i) => {
    const on = TOKENS[i] === id;
    t.classList.toggle('is-selected', on);
    t.setAttribute('aria-checked', on ? 'true' : 'false');
  });
  updateTokenPreview();
}

function updateTokenPreview() {
  const pv = document.getElementById('token-preview');
  const av = document.getElementById('preview-avatar');
  const nm = document.getElementById('preview-name');
  av.innerHTML = svgUse(draft.token);
  nm.textContent = draft.name || 'Your name';
  pv.hidden = false;
}

function buildEmoteWheel() {
  const EMOTES = ['👏', '😎', '🔥', '😱', 'GG'];
  const wheel = document.getElementById('emote-list');
  wheel.innerHTML = '';
  EMOTES.forEach((e) => {
    const b = document.createElement('button');
    const isText = !/\p{Emoji}/u.test(e);
    b.className = 'emote-btn' + (isText ? ' emote-btn--text' : '');
    b.textContent = e;
    b.setAttribute('aria-label', `React ${e}`);
    b.addEventListener('click', () => {
      react(e);
      floatEmote(e);
      document.getElementById('emote-wheel').hidden = true;
    });
    wheel.appendChild(b);
  });
}

/* ════════════════════════════════════════════════════════════════════════════
   EVENT WIRING
   ════════════════════════════════════════════════════════════════════════════ */
function wireEvents() {
  // Home
  document.getElementById('home-host').addEventListener('click', () => {
    draft.intent = 'host'; showScreen('rules');
  });
  setupCodeEntry('#home-join-form', (code) => { draft.code = code; });
  document.getElementById('home-join-go').addEventListener('click', goJoinFromHome);
  document.getElementById('home-join-form').addEventListener('submit', (e) => { e.preventDefault(); goJoinFromHome(); });
  document.getElementById('home-spectate').addEventListener('click', () => {
    if (draft.code.length === 4) spectate(draft.code);
    else showScreen('join');
  });

  // Back buttons
  document.querySelectorAll('[data-nav]').forEach((b) =>
    b.addEventListener('click', () => showScreen(b.dataset.nav)));

  // Rules — seats stepper
  document.getElementById('seats-minus').addEventListener('click', () => bumpSeats(-1));
  document.getElementById('seats-plus').addEventListener('click', () => bumpSeats(1));
  document.getElementById('rules-create').addEventListener('click', () => {
    draft.intent = 'host'; showScreen('identity');
  });

  // Join screen
  setupCodeEntry('#join-form', (code) => { draft.code = code; });
  document.getElementById('join-continue').addEventListener('click', goJoinContinue);
  document.getElementById('join-form').addEventListener('submit', (e) => { e.preventDefault(); goJoinContinue(); });
  document.getElementById('join-spectate').addEventListener('click', () => {
    const err = document.getElementById('join-error');
    if (draft.code.length !== 4) { err.hidden = false; err.textContent = 'Enter the 4-letter code to watch.'; return; }
    err.hidden = true; spectate(draft.code);
  });

  // Info buttons → show the explanation as a toast (never overlaps the layout)
  document.querySelectorAll('.info-i').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.preventDefault();
      const tip = b.getAttribute('data-tip');
      if (tip) toast(tip, 3600);
    });
  });

  // Identity
  const nameInput = document.getElementById('name-input');
  nameInput.addEventListener('input', () => { draft.name = nameInput.value; updateTokenPreview(); });
  document.getElementById('identity-ready').addEventListener('click', submitIdentity);
  document.getElementById('identity-back').addEventListener('click', () => {
    showScreen(draft.intent === 'host' ? 'rules' : 'join');
  });

  // Lobby
  document.getElementById('lobby-code-copy').addEventListener('click', copyCode);
  document.getElementById('lobby-start').addEventListener('click', () => { sound.play('click'); net.send('start'); });
  document.getElementById('lobby-ready').addEventListener('click', () => { sound.play('click'); net.send('ready'); });
  document.getElementById('lobby-leave').addEventListener('click', leave);

  // Table — drawers / panels
  document.getElementById('open-chat').addEventListener('click', () => {
    const p = document.getElementById('chat-drawer');
    p.hidden = !p.hidden;
    if (!p.hidden) clearChatUnread();
  });
  toggleBtn('open-log', 'log-drawer');
  toggleBtn('open-emotes', 'emote-wheel');
  toggleBtn('open-help', 'help-drawer');
  document.querySelectorAll('[data-close]').forEach((b) =>
    b.addEventListener('click', () => { document.getElementById(b.dataset.close).hidden = true; }));
  document.getElementById('table-leave').addEventListener('click', leave);
  document.getElementById('table-code').addEventListener('click', copyCode);
  document.getElementById('table-finish').addEventListener('click', () => {
    if (confirm('Finish the game for everyone and show final standings?')) {
      sound.play('click'); net.send('finish');
    }
  });

  // Sound on/off
  document.getElementById('sound-btn').addEventListener('click', () => {
    sound.toggle(); syncSoundButton();
  });

  // Chat compose
  document.getElementById('chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const inp = document.getElementById('chat-input');
    const text = inp.value.trim();
    if (text) { chat(text); inp.value = ''; }
  });

  // Action bar
  wireActionBar();

  // Results
  document.getElementById('results-again').addEventListener('click', () => net.send('start'));
  document.getElementById('results-home').addEventListener('click', goHome);

  // Fullscreen toggle (reclaim the browser chrome space on phones)
  wireFullscreen();

  // Light click feedback for UI buttons. Betting actions play their own,
  // richer sounds (see sendAction), so they're excluded here.
  document.addEventListener('click', (e) => {
    const t = e.target.closest('.btn, .seg__opt, .preset, .token, .stepper__btn, .iconbtn-back, .iconbtn-close, .roomcode, .emote-btn, .linkbtn, .home__join + *');
    if (t && !t.disabled) sound.play('click');
  }, true);
}

function wireFullscreen() {
  const btn = document.getElementById('fullscreen-btn');
  if (!btn) return;
  const docEl = document.documentElement;
  const isFs = () => document.fullscreenElement || document.webkitFullscreenElement;
  const sync = () => btn.setAttribute('aria-label', isFs() ? 'Exit fullscreen' : 'Enter fullscreen');

  btn.addEventListener('click', async () => {
    try {
      if (!isFs()) {
        if (docEl.requestFullscreen) await docEl.requestFullscreen();
        else if (docEl.webkitRequestFullscreen) docEl.webkitRequestFullscreen();
        else { toast('On iPhone: Share → Add to Home Screen for fullscreen'); return; }
      } else if (document.exitFullscreen) await document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    } catch { toast('Fullscreen not available here'); }
  });
  document.addEventListener('fullscreenchange', sync);
  document.addEventListener('webkitfullscreenchange', sync);
}

function toggleBtn(btnId, panelId) {
  document.getElementById(btnId).addEventListener('click', () => {
    const p = document.getElementById(panelId);
    p.hidden = !p.hidden;
  });
}

function bumpSeats(d) {
  const next = Math.min(8, Math.max(2, draft.settings.maxSeats + d));
  draft.settings.maxSeats = next;
  document.getElementById('seats-value').textContent = next;
}

// Wire a 4-box code entry: auto-advance, backspace, paste; reports on change.
function setupCodeEntry(formSel, onChange) {
  const form = document.querySelector(formSel);
  const boxes = [...form.querySelectorAll('.code-box')];
  const read = () => boxes.map((b) => b.value).join('').toUpperCase();
  boxes.forEach((box, i) => {
    box.addEventListener('input', () => {
      box.value = box.value.replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 1);
      box.classList.toggle('is-filled', !!box.value);
      if (box.value && i < boxes.length - 1) boxes[i + 1].focus();
      onChange(read());
    });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !box.value && i > 0) boxes[i - 1].focus();
    });
    box.addEventListener('paste', (e) => {
      e.preventDefault();
      const txt = (e.clipboardData.getData('text') || '').replace(/[^a-zA-Z]/g, '').toUpperCase();
      boxes.forEach((b, j) => { b.value = txt[j] || ''; b.classList.toggle('is-filled', !!b.value); });
      onChange(read());
      const next = Math.min(txt.length, boxes.length - 1);
      boxes[next].focus();
    });
  });
}

/* ════════════════════════════════════════════════════════════════════════════
   PRE-GAME FLOW
   ════════════════════════════════════════════════════════════════════════════ */
function goJoinFromHome() {
  if (draft.code.length === 4) { draft.intent = 'join'; showScreen('identity'); }
  else showScreen('join');
}
function goJoinContinue() {
  const err = document.getElementById('join-error');
  if (draft.code.length !== 4) { err.hidden = false; err.textContent = 'Enter the 4-letter code.'; return; }
  err.hidden = true; draft.intent = 'join'; showScreen('identity');
}

function submitIdentity() {
  const err = document.getElementById('identity-error');
  draft.name = document.getElementById('name-input').value.replace(/\s+/g, ' ').trim().slice(0, 16);
  if (!draft.name) { err.hidden = false; err.textContent = 'Pick a display name.'; return; }
  err.hidden = true;

  // Persist identity so a future rejoin can re-supply name/token if needed.
  net.saveSession({ name: draft.name, token: draft.token });

  if (draft.intent === 'host') createTable(draft.settings);
  else join(draft.code, draft.name, draft.token);
}

/* ════════════════════════════════════════════════════════════════════════════
   ACTION SENDERS (intents → server)
   ════════════════════════════════════════════════════════════════════════════ */
function createTable(settings) {
  net.saveSession({ name: draft.name, token: draft.token });
  // Host also needs a seat: send create, then the server's `joined`/`state`
  // will place us. We include identity so the server can seat the host.
  net.send('create', { settings, name: draft.name, token: draft.token });
}
function join(code, name, token) {
  net.saveSession({ code });
  net.send('join', { code, name, token });
}
function spectate(code) { net.send('spectate', { code }); }
function ready() { net.send('ready'); }
function start() { net.send('start'); }
function sendAction(action, amount) {
  // Guard against double-fire: a second tap before the server's next state
  // arrives would land as "not your turn" (the re-raise "something went wrong").
  if (actionPending) return;
  const payload = { action };
  if (amount != null) payload.amount = amount;
  actionPending = true;
  setActionBarLocked(true);
  sound.play(action); // fold | check | call | raise | allin
  net.send('action', payload);
}

function setActionBarLocked(on) {
  const bar = document.getElementById('actionbar');
  if (bar) bar.classList.toggle('is-disabled', on);
}
function chat(text) {
  // No optimistic local echo: the server fans EVERY message back to all sockets
  // including the sender, so echoing here would show our own messages twice.
  net.send('chat', { text });
  sound.play('click');
}
function react(emote) { net.send('react', { emote }); }
function kick(playerId) { net.send('kick', { playerId }); }
function leave() {
  const phase = state?.room?.phase;
  const inGame = phase === 'in-hand' || phase === 'hand-over';
  if (inGame) {
    // Stepping away mid-game is a soft disconnect: keep the seat (shown as
    // disconnected) with the 2-minute reconnect grace. Close the socket but DO
    // NOT clear the session, so reopening the page rejoins the same seat.
    net.disconnect();
    state = null;
    showScreen('home');
    toast('You left the table — reopen within 2 min to keep your seat', 4000);
  } else {
    // Lobby / results: a real leave (host closes the room; a player frees a seat).
    net.send('leave');
    goHome();
  }
}

function goHome() {
  net.clearSession?.();
  state = null;
  showScreen('home');
}

/* ════════════════════════════════════════════════════════════════════════════
   RENDER · LOBBY
   ════════════════════════════════════════════════════════════════════════════ */
function renderLobby() {
  const { room, players, you } = state;
  document.getElementById('lobby-code').textContent = room.code || '----';

  // settings tags
  const tags = settingsTags(room.settings);
  document.getElementById('lobby-tags').innerHTML =
    tags.map((t) => `<span class="tag">${t}</span>`).join('');

  // watching
  document.getElementById('lobby-watch').textContent = `👁 ${room.spectatorCount || 0} watching`;

  // count
  document.getElementById('lobby-count').textContent =
    `${players.length} / ${room.settings.maxSeats}`;

  // host-only controls
  const isHost = !!you.isHost;
  const startBtn = document.getElementById('lobby-start');
  startBtn.style.display = isHost ? '' : 'none';
  const readyBtn = document.getElementById('lobby-ready');
  readyBtn.style.display = isHost ? 'none' : '';

  // The host can only start once there are 2+ players AND every non-host is ready.
  const others = players.filter((p) => !p.isHost);
  const allReady = others.length > 0 && others.every((p) => p.ready);
  const canStart = players.length >= 2 && allReady;
  startBtn.disabled = !canStart;

  document.getElementById('lobby-role').textContent = isHost
    ? (canStart ? 'Everyone’s ready — start when you are!' : 'Waiting for players to ready up…')
    : "You're in the lobby";

  // Ready toggle reflects current state: tapping flips it and the colour changes
  // so it's obvious the state changed on every click.
  const me = players.find((p) => p.id === you.id);
  const iAmReady = !!me?.ready;
  readyBtn.textContent = iAmReady ? "I'm ready ✓" : 'Tap to join';
  readyBtn.classList.toggle('is-ready', iAmReady);

  // Leave / close label.
  const leaveText = document.getElementById('lobby-leave-text');
  if (leaveText) leaveText.textContent = isHost ? 'Close table' : 'Leave table';

  // player grid (+ open seats)
  const grid = document.getElementById('lobby-players');
  grid.innerHTML = '';
  players.forEach((p) => grid.appendChild(lobbyRow(p, isHost, you.id)));
  const open = Math.max(0, room.settings.maxSeats - players.length);
  for (let i = 0; i < open; i++) grid.appendChild(openSeatRow());
}

function lobbyRow(p, viewerIsHost, myId) {
  const row = document.createElement('div');
  row.className = 'player-row';

  let statusHtml;
  if (p.isHost) statusHtml = `<div class="player-row__status is-host">host</div>`;
  else if (p.ready) statusHtml = `<div class="player-row__status is-ready"><svg width="11" height="11" aria-hidden="true"><use href="${SPRITE}#ready-status"></use></svg> ready</div>`;
  else statusHtml = `<div class="player-row__status is-waiting">sitting…</div>`;

  const crown = p.isHost
    ? `<svg aria-hidden="true"><use href="${SPRITE}#host-crown"></use></svg>` : '';

  const kick = (viewerIsHost && p.id !== myId)
    ? `<button class="player-row__kick" data-kick="${p.id}" aria-label="Kick ${escapeHtml(p.name)}"><svg aria-hidden="true"><use href="${SPRITE}#kick-player"></use></svg></button>` : '';

  row.innerHTML = `
    ${avatarHtml(p.token, 'sm')}
    <div class="player-row__info">
      <div class="player-row__name">${escapeHtml(p.name)} ${crown}</div>
      ${statusHtml}
    </div>
    ${kick}`;

  const kb = row.querySelector('[data-kick]');
  if (kb) kb.addEventListener('click', () => kick(kb.dataset.kick));
  return row;
}

function openSeatRow() {
  const row = document.createElement('div');
  row.className = 'player-row player-row--empty';
  row.innerHTML = `<span class="seat-avatar seat-avatar--sm">+</span><span class="player-row__open">Open seat</span>`;
  return row;
}

/* ════════════════════════════════════════════════════════════════════════════
   RENDER · TABLE
   ════════════════════════════════════════════════════════════════════════════ */
function renderTable() {
  const { room, players, hand, you } = state;

  // top bar
  document.getElementById('table-code-text').textContent = room.code || '----';
  document.getElementById('hand-pill').textContent = `Hand ${hand?.handNumber ?? '—'}`;
  document.getElementById('blinds-pill').textContent = blindsLabel();

  // host can finish the whole game from the table
  document.getElementById('table-finish').hidden = !you.isHost;

  // pot + board
  document.getElementById('pot-amount').textContent = `Pot ${fmt(hand?.pot ?? 0)}`;
  renderBoard(hand?.board || []);

  // seats around the felt
  renderSeats(players, hand, you);

  // your hole cards + plate
  renderYou(players, you);

  // winner banner during the hand-over reveal
  renderShowdown();

  // action bar vs spectator footer
  const spectating = !!you.isSpectator;
  document.getElementById('actionbar').hidden = spectating;
  document.getElementById('you-zone').hidden = spectating;
  const foot = document.getElementById('spectate-foot');
  foot.hidden = !spectating;
  if (spectating) {
    document.getElementById('spectate-foot-text').textContent =
      `You're spectating${room.spectatorCount > 1 ? ` · ${room.spectatorCount - 1} others watching` : ''}`;
  } else {
    renderActionBar(hand, players, you);
  }
}

// Map of playerId → 'sb' | 'bb' for the current hand (for blind badges).
function blindRoles(players, hand) {
  const roles = {};
  if (!hand) return roles;
  const bySeat = (seat) => players.find((p) => p.seat === seat);
  const sb = hand.sbSeat != null ? bySeat(hand.sbSeat) : null;
  const bb = hand.bbSeat != null ? bySeat(hand.bbSeat) : null;
  if (sb) roles[sb.id] = 'sb';
  if (bb) roles[bb.id] = 'bb';
  return roles;
}

function blindBadge(role) {
  if (!role) return '';
  const id = role === 'sb' ? 'blind-small' : 'blind-big';
  const label = role === 'sb' ? 'Small blind' : 'Big blind';
  return `<span class="blind-badge blind-badge--${role}" aria-label="${label}"><svg aria-hidden="true"><use href="#${id}"></use></svg></span>`;
}

// Winner / showdown overlay shown while phase === 'hand-over'.
function renderShowdown() {
  const banner = document.getElementById('showdown-banner');
  const isOver = state?.room?.phase === 'hand-over' && state?.result;
  banner.hidden = !isOver;
  if (!isOver) return;

  const r = state.result;
  const w = r.winners?.[0];
  const many = (r.winners?.length || 0) > 1;
  document.getElementById('showdown-kicker-text').textContent = r.showdown ? 'Showdown' : 'Winner';
  document.getElementById('showdown-name').textContent = many
    ? `${r.winners.map((x) => x.name).join(' & ')} split the pot`
    : (w?.name || '—');
  const handEl = document.getElementById('showdown-hand');
  handEl.innerHTML = w?.handName ? `with <b>${escapeHtml(w.handName)}</b>` : 'takes the pot';

  // Pot amount won (sum of all winners' payouts).
  const pot = (r.winners || []).reduce((sum, x) => sum + (x.amount || 0), 0);
  const amtWrap = document.getElementById('showdown-amount');
  document.getElementById('showdown-amount-text').textContent = `+${fmt(pot)}`;
  amtWrap.hidden = pot <= 0;

  const cards = document.getElementById('showdown-cards');
  cards.innerHTML = (w?.bestCards || []).map(cardHtml).join('');
}

function renderBoard(board) {
  const el = document.getElementById('board');
  el.innerHTML = '';
  // Always show 5 slots; face-down card-backs for undealt streets.
  for (let i = 0; i < 5; i++) {
    if (board[i]) {
      const c = cardEl(board[i]);
      // Animate just the cards revealed this update (flop/turn/river).
      if (animBoardFrom >= 0 && i >= animBoardFrom) {
        c.classList.add('pcard--reveal');
        c.style.animationDelay = `${(i - animBoardFrom) * 90}ms`;
      }
      el.appendChild(c);
    } else {
      el.appendChild(cardBackEl());
    }
  }
}

function renderSeats(players, hand, you) {
  const seats = document.getElementById('seats');
  seats.innerHTML = '';
  // Render everyone EXCEPT "you" (you sit at the bottom in the you-zone).
  const others = players.filter((p) => p.id !== you.id);
  const roles = blindRoles(players, hand);

  // Distribute around the top arc of the oval. Positions as % of felt-wrap.
  const positions = arcPositions(others.length);
  others.forEach((p, i) => {
    const pos = positions[i];
    seats.appendChild(seatEl(p, pos, hand, roles[p.id]));
  });
}

// Returns left/top % coordinates around the upper arc of the table.
function arcPositions(n) {
  if (n <= 0) return [];
  // Spread across the top; clamp endpoints inside the felt.
  const slots = {
    1: [[50, 14]],
    2: [[28, 18], [72, 18]],
    3: [[24, 22], [50, 12], [76, 22]],
    4: [[18, 26], [38, 14], [62, 14], [82, 26]],
    5: [[16, 30], [33, 16], [50, 12], [67, 16], [84, 30]],
    6: [[15, 34], [28, 18], [44, 13], [60, 13], [74, 18], [85, 34]],
    7: [[14, 40], [22, 22], [37, 14], [50, 12], [63, 14], [78, 22], [86, 40]],
  };
  return slots[Math.min(n, 7)] || slots[7];
}

function seatEl(p, pos, hand, role) {
  const el = document.createElement('div');
  const isActive = hand && p.id === hand.activePlayerId;
  const offline = p.status === 'disconnected';
  el.className = 'seat'
    + (p.hasFolded ? ' seat--folded' : '')
    + (isActive ? ' seat--active' : '')
    + (offline ? ' seat--offline' : '');
  el.style.left = pos[0] + '%';
  el.style.top = pos[1] + '%';

  const isDealer = hand && p.seat === hand.dealerSeat;
  const timerBadge = isActive ? `<div class="seat__timer" data-deadline="${hand.actDeadline ?? ''}">--</div>` : '';
  const offlineBadge = offline
    ? `<div class="seat__offline" aria-label="Disconnected"><svg aria-hidden="true"><use href="#connection"></use></svg></div>` : '';
  const dealerBadge = isDealer
    ? `<div class="seat__dealer" aria-label="Dealer"><svg aria-hidden="true"><use href="${SPRITE}#dealer-button"></use></svg></div>` : '';
  const betBadge = (p.bet > 0)
    ? `<div class="seat__bet"><span class="seat__bet-dot" style="background:${colorFor(p.token)}"></span><span class="seat__bet-amt">${fmt(p.bet)}</span></div>` : '';

  // Opponent cards: revealed (face up) at showdown, else face-down backs while
  // they're live in the hand.
  let oppCards = '';
  if (p.holeCards && p.holeCards.length === 2) {
    oppCards = `<div class="seat__cards seat__cards--up">${p.holeCards.map(cardMiniHtml).join('')}</div>`;
  } else if (hand && p.inHand && !p.hasFolded) {
    oppCards = `<div class="seat__cards">${cardBackMiniHtml()}${cardBackMiniHtml()}</div>`;
  }

  const sub = p.hasFolded
    ? `<div class="seat__chips">folded</div>`
    : `<div class="seat__chips">${fmt(p.chips)}</div>`;

  const plateSub = offline
    ? `<div class="seat__chips seat__chips--off">disconnected</div>`
    : sub;

  el.innerHTML = `
    ${oppCards}
    <div class="seat__avatar-wrap">
      ${avatarHtml(p.token, 'lg')}
      ${dealerBadge}${blindBadge(role)}${offlineBadge}${timerBadge}
    </div>
    <div class="seat__plate">
      <div class="seat__name">${escapeHtml(p.name)}</div>
      ${plateSub}
      ${betBadge}
    </div>`;
  return el;
}

function renderYou(players, you) {
  const me = players.find((p) => p.id === you.id);
  const zone = document.getElementById('you-zone');
  if (!me) { zone.innerHTML = ''; return; }

  const dealt = me.holeCards && me.holeCards.length === 2;
  const hole = dealt
    ? me.holeCards.map(cardHtml).join('')
    : `${cardBackHtml()}${cardBackHtml()}`;

  const crown = me.isHost ? `<svg aria-hidden="true"><use href="${SPRITE}#host-crown"></use></svg>` : '';
  const role = blindRoles(players, state.hand)[me.id];

  zone.innerHTML = `
    <div class="you-hole${animDealHole && dealt ? ' is-dealing' : ''}">${hole}</div>
    <div class="you-plate">
      ${avatarHtml(me.token, 'sm')}
      <div>
        <div class="you-plate__name">${escapeHtml(me.name)} ${blindBadge(role)} ${crown}</div>
        <div class="you-plate__chips">${fmt(me.chips)}</div>
      </div>
    </div>`;
}

/* ════════════════════════════════════════════════════════════════════════════
   THE REDESIGNED ACTION BAR
   ════════════════════════════════════════════════════════════════════════════ */
function wireActionBar() {
  const slider = document.getElementById('ab-slider');
  slider.addEventListener('input', () => { setAbAmount(Number(slider.value), 'slider'); });

  document.getElementById('ab-minus').addEventListener('click', () => stepAb(-1));
  document.getElementById('ab-plus').addEventListener('click', () => stepAb(1));

  document.querySelectorAll('#ab-presets .preset').forEach((b) =>
    b.addEventListener('click', () => applyPreset(b.dataset.preset)));

  document.getElementById('ab-fold').addEventListener('click', () => sendAction('fold'));
  document.getElementById('ab-check').addEventListener('click', onCheckCall);
  document.getElementById('ab-raise').addEventListener('click', onRaise);
}

function renderActionBar(hand, players, you) {
  const bar = document.getElementById('actionbar');
  const waiting = document.getElementById('ab-waiting');
  const sizing = document.getElementById('ab-sizing');
  const actions = document.getElementById('ab-actions');
  const legal = hand?.legal || null;

  const timer = document.getElementById('ab-timer');

  // Not your turn → dim the whole bar and name the active player.
  if (!legal) {
    bar.classList.add('is-disabled');
    waiting.hidden = false;
    sizing.hidden = true;
    actions.hidden = true;
    if (timer) timer.hidden = true;
    const active = players.find((p) => p.id === hand?.activePlayerId);
    document.getElementById('ab-waiting-text').textContent =
      active ? `Waiting for ${active.name}…` : 'Waiting for next hand…';
    return;
  }

  bar.classList.remove('is-disabled');
  waiting.hidden = true;
  actions.hidden = false;
  // Show my own countdown (only when a turn clock is running).
  if (timer) { timer.hidden = !hand.actDeadline; updateAbTimer(); }

  // ── Shove-only mode: can't raise but can go all-in (stack ≤ callAmount) ──
  if (!legal.canRaise && legal.canAllIn && legal.allInAmount <= legal.callAmount) {
    sizing.hidden = true;
    renderActions(legal, hand, /* shoveOnly */ true);
    return;
  }

  // ── Standard mode ──
  const canRaise = !!legal.canRaise;
  sizing.hidden = !canRaise;

  if (canRaise) {
    // Context labels
    document.getElementById('ab-tocall').textContent = `To call ${fmt(legal.callAmount)}`;
    document.getElementById('ab-pot').textContent = `Pot ${fmt(hand.pot)}`;

    // Slider bounds
    const slider = document.getElementById('ab-slider');
    slider.min = legal.minRaiseTo;
    slider.max = legal.maxRaiseTo;
    slider.step = Math.max(1, hand.minRaise || 1);

    // Reset the amount to min raise whenever the legal context changes (a new
    // turn/street). Across re-renders of the SAME context, keep the user's
    // current amount so slider drags / presets survive a state refresh.
    const sig = `${hand.handNumber}:${hand.street}:${legal.minRaiseTo}:${legal.maxRaiseTo}:${legal.callAmount}`;
    if (sig !== abLegalSig) {
      abLegalSig = sig;
      abAmount = legal.minRaiseTo;
    }
    setAbAmount(clamp(abAmount, legal.minRaiseTo, legal.maxRaiseTo), 'init');
    highlightPreset(detectPreset(legal, hand));
  }

  renderActions(legal, hand, false);
}

function renderActions(legal, hand, shoveOnly) {
  const fold = document.getElementById('ab-fold');
  const check = document.getElementById('ab-check');
  const raise = document.getElementById('ab-raise');

  // Fold
  fold.hidden = !legal.canFold;
  fold.innerHTML = `${svgUse('action-fold')}Fold`;

  if (shoveOnly) {
    // Collapse to a single all-in primary (plus fold if allowed).
    check.hidden = true;
    raise.hidden = false;
    raise.className = 'abtn abtn--allin';
    raise.innerHTML = `${svgUse('action-all-in')}All-in (${fmt(legal.allInAmount)})`;
    raise.onclick = () => sendAction('allin');
    return;
  }

  // Check / Call (outlined secondary)
  check.hidden = false;
  if (legal.callAmount === 0 && legal.canCheck) check.innerHTML = `${svgUse('action-check')}Check`;
  else check.innerHTML = `${svgUse('action-call')}Call ${fmt(legal.callAmount)}`;
  check.disabled = !(legal.canCheck || legal.canCall);

  // Bet / Raise (accent primary) — only when raising is possible
  if (legal.canRaise) {
    raise.hidden = false;
    raise.className = 'abtn abtn--raise';
    raise.onclick = onRaise;
    updateRaiseLabel(hand);
  } else {
    raise.hidden = true;
  }
}

function updateRaiseLabel(hand) {
  const raise = document.getElementById('ab-raise');
  const isBet = (hand?.currentBet ?? 0) === 0;
  raise.innerHTML = `${svgUse('action-raise-bet')}${isBet ? 'Bet' : 'Raise to'} ${fmt(abAmount)}`;
}

// Set the current raise-to amount, syncing slider + readout + raise label.
function setAbAmount(value, source) {
  const legal = state?.hand?.legal;
  if (!legal) return;
  abAmount = clamp(Math.round(value), legal.minRaiseTo, legal.maxRaiseTo);

  const slider = document.getElementById('ab-slider');
  if (source !== 'slider') slider.value = abAmount;
  document.getElementById('ab-amount').textContent = fmt(abAmount);
  updateRaiseLabel(state.hand);

  if (source !== 'preset-click') highlightPreset(detectPreset(legal, state.hand));
}

function stepAb(dir) {
  const hand = state?.hand;
  if (!hand?.legal) return;
  const step = Math.max(1, hand.minRaise || hand.bigBlind || 1);
  setAbAmount(abAmount + dir * step, 'step');
}

// Compute and apply a preset's real chip amount.
function applyPreset(kind) {
  const hand = state?.hand;
  const legal = hand?.legal;
  if (!legal) return;
  let amt;
  switch (kind) {
    case 'min':  amt = legal.minRaiseTo; break;
    case '2x':   amt = multipleRaiseTo(hand, legal, 2); break;
    case '3x':   amt = multipleRaiseTo(hand, legal, 3); break;
    case 'allin': amt = legal.maxRaiseTo; break;
    case 'half': amt = potRaiseTo(hand, legal, 0.5); break;
    case 'pot':  amt = potRaiseTo(hand, legal, 1); break;
    default: return;
  }
  setAbAmount(clamp(amt, legal.minRaiseTo, legal.maxRaiseTo), 'preset-click');
  highlightPreset(kind);
}

// "N-bet": raise the bet level to N× its current size. Preflop with a 10 big
// blind, 2× = raise to 20, 3× = 30. With no bet yet, the big blind is the base.
function multipleRaiseTo(hand, legal, mult) {
  const base = (hand.currentBet && hand.currentBet > 0) ? hand.currentBet : (hand.bigBlind || hand.minRaise || 1);
  return clamp(base * mult, legal.minRaiseTo, legal.maxRaiseTo);
}

// Pot-sized "raise to": call first, then bet `frac × (pot after calling)`.
function potRaiseTo(hand, legal, frac) {
  const pot = hand.pot || 0;
  const call = legal.callAmount || 0;
  const potAfterCall = pot + call;
  const raiseBy = Math.round(potAfterCall * frac);
  // "raise to" = current bet we must match + our raise increment
  const to = (hand.currentBet || 0) + call + raiseBy;
  return clamp(to, legal.minRaiseTo, legal.maxRaiseTo);
}

// Figure out which preset (if any) the current amount matches.
function detectPreset(legal, hand) {
  if (abAmount === legal.minRaiseTo) return 'min';
  if (abAmount === legal.maxRaiseTo) return 'allin';
  if (abAmount === multipleRaiseTo(hand, legal, 2)) return '2x';
  if (abAmount === multipleRaiseTo(hand, legal, 3)) return '3x';
  if (abAmount === potRaiseTo(hand, legal, 1)) return 'pot';
  if (abAmount === potRaiseTo(hand, legal, 0.5)) return 'half';
  return null;
}

function highlightPreset(kind) {
  document.querySelectorAll('#ab-presets .preset').forEach((b) =>
    b.classList.toggle('is-on', b.dataset.preset === kind));
}

function onCheckCall() {
  const legal = state?.hand?.legal;
  if (!legal) return;
  if (legal.callAmount === 0 && legal.canCheck) sendAction('check');
  else if (legal.canCall) sendAction('call');
}

function onRaise() {
  const legal = state?.hand?.legal;
  if (!legal || !legal.canRaise) return;
  // If we've maxed out the slider, that's an all-in.
  if (abAmount >= legal.maxRaiseTo && legal.canAllIn) sendAction('allin');
  else sendAction('raise', abAmount);
}

/* ════════════════════════════════════════════════════════════════════════════
   RENDER · RESULTS
   ════════════════════════════════════════════════════════════════════════════ */
function renderResults() {
  const { players, result } = state;
  const winner = result?.winners?.[0];

  document.getElementById('results-name').textContent = winner?.name || '—';
  const handEl = document.getElementById('results-hand');
  handEl.innerHTML = winner?.handName
    ? `takes the pot with a <b>${escapeHtml(winner.handName)}</b>`
    : 'takes the pot';

  // winning cards
  const cards = document.getElementById('results-cards');
  cards.innerHTML = (winner?.bestCards || []).map(cardHtml).join('');

  // standings (sorted by chips desc)
  const sorted = [...players].sort((a, b) => b.chips - a.chips);
  const st = document.getElementById('results-standings');
  st.innerHTML = '';
  sorted.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'standing' + (i === 0 ? ' standing--win' : '');
    row.innerHTML = `
      <span class="standing__rank ${i === 0 ? 'standing__rank--win' : ''}">${i + 1}</span>
      ${avatarHtml(p.token, 'sm')}
      <span class="standing__name">${escapeHtml(p.name)}</span>
      <span class="standing__chips">${fmt(p.chips)}</span>`;
    st.appendChild(row);
  });
}

/* ════════════════════════════════════════════════════════════════════════════
   CHAT / EMOTES
   ════════════════════════════════════════════════════════════════════════════ */
function pushChat(m) {
  const box = document.getElementById('chat-messages');
  const mine = m.me || (state?.you && m.id && m.id === state.you.id);
  const div = document.createElement('div');
  div.className = 'chat-msg' + (mine ? ' chat-msg--me' : '');
  const color = m.token ? colorFor(m.token) : 'var(--ink)';
  div.innerHTML = `
    <span class="chat-msg__who" style="color:${color}">${escapeHtml(m.name || '')}</span>
    <span class="chat-msg__bubble">${escapeHtml(m.text || '')}</span>`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;

  // Notification dot when a message from someone else arrives with chat closed.
  const drawer = document.getElementById('chat-drawer');
  if (!mine && drawer && drawer.hidden) setChatUnread();
}

function clearChat() {
  const box = document.getElementById('chat-messages');
  if (box) box.innerHTML = '';
  clearChatUnread();
}
function setChatUnread() {
  chatUnread = true;
  const d = document.getElementById('chat-dot');
  if (d) d.hidden = false;
}
function clearChatUnread() {
  chatUnread = false;
  const d = document.getElementById('chat-dot');
  if (d) d.hidden = true;
}

function floatEmote(emote) {
  const layer = document.getElementById('emote-floats');
  if (!layer) return;
  const el = document.createElement('div');
  el.className = 'emote-float';
  el.textContent = emote;
  el.style.left = (40 + Math.random() * 20) + '%';
  el.style.top = '55%';
  layer.appendChild(el);
  setTimeout(() => el.remove(), 1800);
}

/* ════════════════════════════════════════════════════════════════════════════
   TURN-TIMER TICKER — counts down active seat from hand.actDeadline (epoch ms)
   ════════════════════════════════════════════════════════════════════════════ */
setInterval(() => {
  const deadline = state?.hand?.actDeadline;
  const badge = document.querySelector('.seat__timer');
  if (badge) {
    if (deadline) {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      const m = Math.floor(left / 60), s = left % 60;
      badge.textContent = `${m}:${String(s).padStart(2, '0')}`;
      badge.classList.toggle('is-urgent', left <= 5);
    } else {
      badge.textContent = '--';
    }
  }
  updateAbTimer();
}, 1000);

// Update my own turn countdown in the action bar (+ tick sounds).
let lastTickLeft = null;
function updateAbTimer() {
  const wrap = document.getElementById('ab-timer');
  const el = document.getElementById('ab-timer-text');
  if (!wrap || !el) return;
  const deadline = state?.hand?.actDeadline;
  if (wrap.hidden || !deadline || !state?.hand?.legal) { lastTickLeft = null; return; }
  const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  el.textContent = `${left}s`;
  wrap.classList.toggle('is-urgent', left <= 5);
  // One tick per whole second on MY clock; a rushing tick in the final stretch.
  if (left !== lastTickLeft) {
    lastTickLeft = left;
    if (left > 0) sound.play(left <= 5 ? 'tickRush' : 'tick');
  }
}

/* ════════════════════════════════════════════════════════════════════════════
   HELPERS
   ════════════════════════════════════════════════════════════════════════════ */
function settingsTags(s) {
  if (!s) return [];
  const stack = s.startingStack >= 1000 ? `${(s.startingStack / 1000).toLocaleString()}k` : `${s.startingStack}`;
  const blinds = `${s.smallBlind}/${s.bigBlind}${s.blindsMode === 'increasing' ? ' ↑' : ''}`;
  const timer = s.turnTimer === 0 ? 'No timer' : `${s.turnTimer}s`;
  const betting = s.betting === 'no-limit' ? 'No-Limit' : s.betting;
  return [betting, blinds, stack, timer];
}

function blindsLabel() {
  const b = state?.blinds;
  if (!b) return 'Blinds —';
  let label = `Blinds ${b.smallBlind}/${b.bigBlind}`;
  // Increasing blinds rise by PROGRESS (every few hands or on a knock-out), not
  // a clock — so show the level and how many hands until the next rise.
  if (b.mode === 'increasing') {
    label += ` · Lv ${b.level}`;
    if (b.handsToNext != null) {
      label += ` · up in ${b.handsToNext} hand${b.handsToNext === 1 ? '' : 's'} / KO`;
    }
  }
  return label;
}

function meName() {
  const me = state?.players?.find((p) => p.id === state.you.id);
  return me?.name || draft.name;
}

function copyCode() {
  const code = state?.room?.code;
  if (!code) return;
  const done = () => toast('Code copied');
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(code).then(done).catch(done);
  else done();
}

function setConn(online) {
  const pill = document.getElementById('conn-pill');
  pill.classList.toggle('conn-pill--online', online);
  pill.classList.toggle('conn-pill--offline', !online);
  document.getElementById('conn-pill-text').textContent = online ? 'Online' : 'Reconnecting…';
}

let toastTimer = null;
function toast(msg, ms = 2200) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// ── small render helpers ──
function svgUse(id) { return `<svg aria-hidden="true"><use href="${SPRITE}#${id}"></use></svg>`; }
function avatarHtml(token, size) {
  return `<span class="seat-avatar seat-avatar--${size}">${svgUse(token)}</span>`;
}
function colorFor(token) { return TOKEN_COLORS[token] || 'var(--ink)'; }

function cardEl(code) {
  const wrap = document.createElement('div');
  wrap.innerHTML = cardHtml(code);
  return wrap.firstElementChild;
}
function cardHtml(code, extra = '') {
  const rank = code[0] === 'T' ? '10' : code[0];
  const suit = code[1];
  const red = RED_SUITS.has(suit);
  return `<div class="pcard ${red ? 'pcard--red' : ''} ${extra}">
    <span class="pcard__rank">${rank}</span>
    <span class="pcard__suit">${svgUse(SUIT_ICON[suit] || 'suit-spade')}</span>
  </div>`;
}
function cardMiniHtml(code) { return cardHtml(code, 'pcard--mini'); }

// Face-down card (sprite card-back). The SVG IS the card — it fills the whole
// face. Used for opponents' hole cards and the undealt community-card slots.
function cardBackHtml(extra = '') {
  return `<div class="pcard pcard--back ${extra}"><svg class="pcard__back" viewBox="0 0 46 66" preserveAspectRatio="none" aria-hidden="true"><use href="#card-back"></use></svg></div>`;
}
function cardBackMiniHtml() { return cardBackHtml('pcard--mini'); }
function cardBackEl() { const d = document.createElement('div'); d.innerHTML = cardBackHtml(); return d.firstElementChild; }

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function fmt(n) { return Number(n || 0).toLocaleString('en-US'); }
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── go ──
boot();
