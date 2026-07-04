// Poka-Poka — room manager (the authoritative game spine).
//
// Owns all rooms in memory, seating, reconnection, turn/blind timers, and the
// per-recipient state broadcast. Pure poker rules live in ./poker/engine.js;
// this file drives them and handles everything stateful around them.

import { randomUUID } from 'node:crypto';
import {
  C2S, S2C, ERR, PHASE, STREET, ACTIONS, TOKENS,
  DEFAULT_SETTINGS, BLIND_LEVEL_HANDS,
  sanitizeSettings, normalizeName, isValidToken, isAction,
} from './protocol.js';
import {
  startHand, legalActions, applyAction,
  isBettingRoundComplete, advanceStreet, settle,
} from './poker/engine.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O for legibility
const CODE_LEN = 4;
// ── Game pacing (developer-tunable) ─────────────────────────────────────────
// These two constants control how much "breathing room" players get to read
// what just happened. Adjust here (ms):
const HAND_OVER_MS = 8000;      // winner banner: pause before the next hand deals
const STREET_PAUSE_MS = 2000;   // pause after a betting round ends before the next street reveals
const OFFLINE_FALLBACK_MS = 30000; // turn clock for an offline player when the table has NO timer (Off)
const DROP_GRACE_MS = Number(process.env.DROP_GRACE_MS) || 2 * 60 * 1000; // disconnect grace before a seat is eliminated

function genCode(taken) {
  let code;
  do {
    code = Array.from({ length: CODE_LEN }, () =>
      CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
  } while (taken.has(code));
  return code;
}

function send(socket, type, payload = {}) {
  if (socket && socket.readyState === 1) {
    socket.send(JSON.stringify({ type, ...payload }));
  }
}

export class RoomManager {
  constructor() {
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
  }

  // ── message entry point ─────────────────────────────────────────────────
  handleMessage(ctx, msg) {
    // ctx = { socket, roomCode, playerId } — mutated as the socket joins a room.
    switch (msg.type) {
      case C2S.CREATE: return this.create(ctx, msg);
      case C2S.JOIN: return this.join(ctx, msg);
      case C2S.REJOIN: return this.rejoin(ctx, msg);
      case C2S.SPECTATE: return this.spectate(ctx, msg);
      case C2S.PEEK: return this.peek(ctx, msg);
      default: {
        const room = this.rooms.get(ctx.roomCode);
        if (!room) return send(ctx.socket, S2C.ERROR, { code: ERR.ROOM_NOT_FOUND });
        return room.handleMessage(ctx, msg);
      }
    }
  }

  create(ctx, msg) {
    const settings = sanitizeSettings(msg.settings || DEFAULT_SETTINGS);
    const name = normalizeName(msg.name);
    const token = isValidToken(msg.token) ? msg.token : 'avatar-01';
    if (!name) return send(ctx.socket, S2C.ERROR, { code: ERR.BAD_MESSAGE, message: 'Name required' });

    const code = genCode(this.rooms);
    const room = new Room(code, settings, this);
    this.rooms.set(code, room);
    const player = room.seatPlayer({ name, token, socket: ctx.socket });
    room.hostId = player.id;
    this._bind(ctx, room, player.id);
    send(ctx.socket, S2C.JOINED, { playerId: player.id, code });
    room.broadcast();
  }

  join(ctx, msg) {
    const room = this.rooms.get(String(msg.code || '').toUpperCase());
    if (!room) return send(ctx.socket, S2C.ERROR, { code: ERR.ROOM_NOT_FOUND });
    // No new players once the game is underway — only the original players can
    // rejoin (via their saved session). Latecomers can watch as spectators.
    if (room.phase !== PHASE.LOBBY) return this.spectate(ctx, { code: room.code });
    const name = normalizeName(msg.name);
    const token = isValidToken(msg.token) ? msg.token : 'avatar-02';
    if (!name) return send(ctx.socket, S2C.ERROR, { code: ERR.BAD_MESSAGE, message: 'Name required' });

    const player = room.seatPlayer({ name, token, socket: ctx.socket });
    if (!player) {
      // table full → fall back to spectating
      return this.spectate(ctx, { code: room.code });
    }
    this._bind(ctx, room, player.id);
    send(ctx.socket, S2C.JOINED, { playerId: player.id, code: room.code });
    room.broadcast();
  }

  rejoin(ctx, msg) {
    const room = this.rooms.get(String(msg.code || '').toUpperCase());
    if (!room) return send(ctx.socket, S2C.ERROR, { code: ERR.ROOM_NOT_FOUND });
    if (room.kicked.has(msg.playerId)) return send(ctx.socket, S2C.ERROR, { code: ERR.KICKED });
    const player = room.players.get(msg.playerId);
    const spec = room.spectators.get(msg.playerId);
    if (!player && !spec) return send(ctx.socket, S2C.ERROR, { code: ERR.PLAYER_NOT_FOUND });

    if (player) {
      player.socket = ctx.socket;
      player.status = 'connected';
      // Reconnected in time → cancel the elimination countdown.
      if (player._dropTimer) { clearTimeout(player._dropTimer); player._dropTimer = null; }
    } else {
      spec.socket = ctx.socket;
    }
    this._bind(ctx, room, msg.playerId);
    send(ctx.socket, S2C.JOINED, { playerId: msg.playerId, code: room.code });
    room.broadcast();
  }

  spectate(ctx, msg) {
    const room = this.rooms.get(String(msg.code || '').toUpperCase());
    if (!room) return send(ctx.socket, S2C.ERROR, { code: ERR.ROOM_NOT_FOUND });
    const id = randomUUID();
    const name = `Guest ${++room.guestCounter}`;
    room.spectators.set(id, { id, socket: ctx.socket, name });
    this._bind(ctx, room, id);
    send(ctx.socket, S2C.JOINED, { playerId: id, code: room.code });
    room.broadcast();
  }

  // Pre-join lookup: which avatars are already taken in a room (so the picker
  // can grey them out). Does not join or bind the socket.
  peek(ctx, msg) {
    const room = this.rooms.get(String(msg.code || '').toUpperCase());
    send(ctx.socket, S2C.ROOM_INFO, {
      code: String(msg.code || '').toUpperCase(),
      exists: !!room,
      takenTokens: room ? [...room.players.values()].map((p) => p.token) : [],
    });
  }

  handleDisconnect(ctx) {
    const room = this.rooms.get(ctx.roomCode);
    if (!room) return;
    room.handleDisconnect(ctx.playerId);
  }

  _bind(ctx, room, playerId) {
    ctx.roomCode = room.code;
    ctx.playerId = playerId;
  }

  disposeRoom(room) {
    room.clearTimers();
    this.rooms.delete(room.code);
  }
}

class Room {
  constructor(code, settings, manager) {
    this.code = code;
    this.settings = settings;
    this.manager = manager;
    this.hostId = null;
    /** @type {Map<string, any>} */
    this.players = new Map();      // seated players (by id)
    this.spectators = new Map();   // by id
    this.kicked = new Set();
    this.guestCounter = 0;         // running number for spectator chat names
    this.phase = PHASE.LOBBY;
    this.hand = null;
    this.handNumber = 0;
    this.dealerSeat = -1;
    this.result = null;
    this.revealAll = false;     // true during a true showdown reveal
    this.blinds = {
      level: 1,
      smallBlind: settings.smallBlind,
      bigBlind: settings.bigBlind,
      mode: settings.blindsMode,
      // hands remaining until the next automatic level-up (increasing mode)
      handsToNext: settings.blindsMode === 'increasing' ? BLIND_LEVEL_HANDS : null,
    };
    this.handsSinceBlindUp = 0; // counts hands toward the next level
    this.aliveCount = null;     // players with chips, to detect eliminations
    this.actDeadline = null;
    this._turnTimer = null;
    this._handOverTimer = null;
    this._streetTimer = null;   // pause between betting rounds (STREET_PAUSE_MS)
    this.actionSeq = 0;         // monotonic counter for broadcast action sounds
    this.lastActionInfo = null; // { seq, playerId, action } — latest applied action
    this.handLog = [];          // per-hand history entries (capped, newest last)
  }

  // ── seating ───────────────────────────────────────────────────────────
  freeSeat() {
    for (let s = 0; s < this.settings.maxSeats; s++) {
      if (![...this.players.values()].some((p) => p.seat === s)) return s;
    }
    return -1;
  }

  seatPlayer({ name, token, socket }) {
    const seat = this.freeSeat();
    if (seat === -1) return null;
    const id = randomUUID();
    // Avatars are unique per table: if the requested one is taken (or invalid),
    // assign the first free avatar so two players never share a token.
    const taken = new Set([...this.players.values()].map((p) => p.token));
    let tok = token;
    if (!tok || taken.has(tok)) tok = TOKENS.find((t) => !taken.has(t)) || token;
    const player = {
      id, name, token: tok, seat,
      chips: this.settings.startingStack,
      status: 'connected',
      ready: false,
      bustedHand: null, // hand number at which they hit 0 chips (for final ranking)
      socket,
    };
    this.players.set(id, player);
    return player;
  }

  seatedInOrder() {
    return [...this.players.values()].sort((a, b) => a.seat - b.seat);
  }

  // ── inbound messages for an already-joined socket ───────────────────────
  handleMessage(ctx, msg) {
    const player = this.players.get(ctx.playerId);
    switch (msg.type) {
      case C2S.READY:
        if (player && this.phase === PHASE.LOBBY) { player.ready = !player.ready; this.broadcast(); }
        break;
      case C2S.START:
        if (ctx.playerId === this.hostId && this.phase === PHASE.LOBBY) this.tryStartGame(ctx);
        break;
      case C2S.FINISH:
        // Host ends the whole game from the table → jump everyone to results.
        if (ctx.playerId === this.hostId && this.phase !== PHASE.LOBBY) this.endGame();
        break;
      case C2S.ACTION:
        this.onAction(ctx.playerId, msg.action, Number(msg.amount));
        break;
      case C2S.CHAT:
        if (typeof msg.text === 'string' && msg.text.trim()) {
          const spec = this.spectators.get(ctx.playerId);
          if (!player && !spec) break; // sender must be in this room
          const meta = player
            ? { name: player.name, token: player.token, guest: false }
            : { name: spec.name || 'Guest', token: null, guest: true };
          this.fanout(S2C.CHAT, { id: ctx.playerId, ...meta, text: msg.text.slice(0, 200), ts: Date.now() });
        }
        break;
      case C2S.REACT:
        if (player) this.fanout(S2C.REACT, { id: ctx.playerId, emote: String(msg.emote || '').slice(0, 8), ts: Date.now() });
        break;
      case C2S.KICK:
        if (ctx.playerId === this.hostId) this.kick(msg.playerId);
        break;
      case C2S.LEAVE:
        this.removeMember(ctx.playerId, true);
        break;
      default:
        send(ctx.socket, S2C.ERROR, { code: ERR.BAD_MESSAGE });
    }
  }

  // ── game start / hand loop ──────────────────────────────────────────────
  activeForHand() {
    return this.seatedInOrder().filter((p) => p.status === 'connected' && p.chips > 0);
  }

  tryStartGame(ctx) {
    const active = this.activeForHand();
    if (active.length < 2) {
      return send(ctx.socket, S2C.ERROR, { code: ERR.ILLEGAL_ACTION, message: 'Need 2+ connected players' });
    }
    // Every non-host player must be ready before the host can start.
    const allReady = active.every((p) => p.id === this.hostId || p.ready);
    if (!allReady) {
      return send(ctx.socket, S2C.ERROR, { code: ERR.ILLEGAL_ACTION, message: 'Everyone must be ready to start' });
    }
    // Baseline for the progress-based "increasing" blinds.
    this.aliveCount = this.seatedInOrder().filter((p) => p.chips > 0).length;
    this.handsSinceBlindUp = 0;
    this.startNextHand();
  }

  // Raise blinds by game PROGRESS (not a clock): one level every
  // BLIND_LEVEL_HANDS hands, plus one level per player eliminated since the
  // previous hand.
  maybeRaiseBlinds() {
    if (this.settings.blindsMode !== 'increasing') return;
    const alive = this.seatedInOrder().filter((p) => p.chips > 0).length;
    let bumps = 0;
    if (this.aliveCount != null && alive < this.aliveCount) bumps += (this.aliveCount - alive);
    this.handsSinceBlindUp += 1;
    if (this.handsSinceBlindUp >= BLIND_LEVEL_HANDS) { bumps += 1; this.handsSinceBlindUp = 0; }
    for (let i = 0; i < bumps; i++) {
      this.blinds.level += 1;
      this.blinds.smallBlind *= 2;
      this.blinds.bigBlind *= 2;
    }
    this.aliveCount = alive;
    this.blinds.handsToNext = BLIND_LEVEL_HANDS - this.handsSinceBlindUp;
  }

  startNextHand() {
    this.clearHandOver();
    const seated = this.activeForHand();
    if (seated.length < 2) { this.endGame(); return; }

    // progress-based blind increase before dealing
    this.maybeRaiseBlinds();

    // rotate the button to the next occupied seat
    const seats = seated.map((p) => p.seat).sort((a, b) => a - b);
    this.dealerSeat = nextSeatFrom(this.dealerSeat, seats);
    this.handNumber += 1;

    const seatedForEngine = seated.map((p) => ({ id: p.id, seat: p.seat, chips: p.chips }));
    this.hand = startHand(seatedForEngine, {
      ...this.settings,
      smallBlind: this.blinds.smallBlind,
      bigBlind: this.blinds.bigBlind,
    }, this.dealerSeat);
    this.hand.handNumber = this.handNumber;
    this.phase = PHASE.IN_HAND;
    this.result = null;
    this.revealAll = false;
    this.lastActionInfo = null; // fresh hand — no stale action to replay
    this.afterStep();
  }

  onAction(playerId, action, amount) {
    if (this.phase !== PHASE.IN_HAND || !this.hand) return;
    const seat = this.hand.seats[this.hand.activeSeat];
    if (!seat || seat.id !== playerId) {
      const p = this.players.get(playerId);
      return send(p?.socket, S2C.ERROR, { code: ERR.NOT_YOUR_TURN });
    }
    if (!isAction(action)) return;
    const res = applyAction(this.hand, playerId, action, amount);
    if (!res || !res.ok) {
      const p = this.players.get(playerId);
      return send(p?.socket, S2C.ERROR, { code: ERR.ILLEGAL_ACTION, message: res?.error });
    }
    // Record the applied action so EVERY client can play its sound/voice.
    // A call/raise that leaves the actor at 0 chips is announced as all-in.
    const effective = (action !== ACTIONS.FOLD && seat.isAllIn) ? ACTIONS.ALLIN : action;
    this.lastActionInfo = { seq: ++this.actionSeq, playerId, action: effective };
    this.afterStep();
  }

  // Drive street progression + timers after any state change, then broadcast.
  // When a betting round completes we do NOT deal the next street immediately:
  // players get STREET_PAUSE_MS to see the final bets, then resolveStreet()
  // deals — one street per pause, so all-in runouts play out dramatically too.
  afterStep() {
    this.clearTurnTimer();
    this.clearStreetPause();

    if (this.phase === PHASE.IN_HAND && this.hand.activeSeat == null) {
      const live = this.hand.seats.filter((s) => s && s.inHand && !s.hasFolded).length;
      // Everyone folded to one player, or betting after the river is done →
      // settle now; the winner banner provides the viewing pause (HAND_OVER_MS).
      if (this.hand.street === STREET.SHOWDOWN || live <= 1) { this.endHand(); return; }
      this.broadcast();
      this._streetTimer = setTimeout(() => this.resolveStreet(), STREET_PAUSE_MS);
      return;
    }

    if (this.phase === PHASE.IN_HAND && this.hand.activeSeat != null) {
      this.scheduleTurnTimer();
    }
    this.broadcast();
  }

  // Deal exactly one street after the pause; pause again if nobody can bet
  // (all-in runout) so each community reveal gets its own beat.
  resolveStreet() {
    this._streetTimer = null;
    if (this.phase !== PHASE.IN_HAND || !this.hand) return;
    const live = this.hand.seats.filter((s) => s && s.inHand && !s.hasFolded).length;
    if (this.hand.street === STREET.SHOWDOWN || live <= 1) { this.endHand(); return; }
    const adv = advanceStreet(this.hand);
    if (adv.showdown || this.hand.street === STREET.SHOWDOWN) { this.endHand(); return; }
    if (this.hand.activeSeat == null) {
      this.broadcast();
      this._streetTimer = setTimeout(() => this.resolveStreet(), STREET_PAUSE_MS);
      return;
    }
    this.scheduleTurnTimer();
    this.broadcast();
  }

  endHand() {
    this.clearTurnTimer();
    this.clearStreetPause();
    const playersById = {};
    for (const p of this.players.values()) playersById[p.id] = { name: p.name };
    const { winners, payouts } = settle(this.hand, playersById);

    // credit winnings to the seat stack and mirror into the bankroll so the
    // hand-over snapshot (which reads the seat) and the next hand agree.
    for (const s of this.hand.seats) {
      if (!s) continue;
      s.chips += payouts[s.id] || 0;
      const p = this.players.get(s.id);
      if (p) p.chips = s.chips;
    }
    // Record bust order for final standings: a player who hits 0 chips is
    // stamped with the hand number they busted on. Busting earlier = ranked
    // lower on the results screen (ties on 0 chips are broken by this).
    for (const s of this.hand.seats) {
      if (!s) continue;
      const p = this.players.get(s.id);
      if (p && p.chips === 0 && p.bustedHand == null) p.bustedHand = this.handNumber;
    }
    // A true showdown = 2+ players still in when betting is done (they went to
    // the end together). Only then do we reveal cards AND the winning hand name.
    // If everyone else folded, the lone winner's hand stays secret — we don't
    // expose their hole cards or even name their hand.
    const liveSeats = this.hand.seats.filter((s) => s && s.inHand && !s.hasFolded);
    this.revealAll = liveSeats.length >= 2;
    const shownWinners = this.revealAll
      ? winners
      : winners.map((w) => ({ ...w, handName: null, bestCards: [] }));
    this.result = { winners: shownWinners, board: this.hand.board.slice(), showdown: this.revealAll };

    // Hand-history entry. `shownWinners` already respects the reveal rule:
    // on a fold-win it carries NO handName/bestCards, so the log shows only
    // the (public) table cards — the winner's hand stays secret.
    this.handLog.push({
      handNumber: this.handNumber,
      showdown: this.revealAll,
      board: this.hand.board.slice(),
      pot: Object.values(payouts).reduce((a, b) => a + b, 0),
      winners: shownWinners.map((w) => ({
        id: w.id,
        name: w.name,
        token: this.players.get(w.id)?.token ?? null,
        amount: w.amount,
        handName: w.handName,
        bestCards: w.bestCards,
      })),
    });
    if (this.handLog.length > 30) this.handLog.shift(); // keep the last 30 hands

    this.phase = PHASE.HAND_OVER;
    this.broadcast();

    this._handOverTimer = setTimeout(() => {
      const withChips = this.seatedInOrder().filter((p) => p.chips > 0);
      if (withChips.length <= 1) this.endGame();
      else this.startNextHand();
    }, HAND_OVER_MS);
  }

  endGame() {
    this.clearTimers();
    this.hand = null;
    this.phase = PHASE.GAME_OVER;
    // result already holds the last hand; standings are derived from chips
    this.broadcast();
  }

  // ── turn / blind timers ─────────────────────────────────────────────────
  scheduleTurnTimer() {
    const seat = this.hand.seats[this.hand.activeSeat];
    const player = seat && this.players.get(seat.id);
    const offline = !player || player.status !== 'connected';
    const secs = this.settings.turnTimer;
    // Disconnected players use the SAME turn clock as everyone else — their turn
    // proceeds normally and only times out when the clock runs out. If the table
    // has no clock (Off) but the active player is offline, fall back to a
    // default so the game can't stall waiting on them.
    let ms = secs > 0 ? secs * 1000 : 0;
    if (offline && ms === 0) ms = OFFLINE_FALLBACK_MS;
    this.actDeadline = ms > 0 ? Date.now() + ms : null;
    this.hand.actDeadline = this.actDeadline;
    if (ms > 0) {
      this._turnTimer = setTimeout(() => this.autoAct(), ms);
    }
  }

  autoAct() {
    if (this.phase !== PHASE.IN_HAND || !this.hand || this.hand.activeSeat == null) return;
    const seat = this.hand.seats[this.hand.activeSeat];
    if (!seat) return;
    const legal = legalActions(this.hand, seat.id);
    // Time-out play: check if it's free, otherwise fold (never auto-spend chips
    // by calling a bet). Applies to slow and disconnected players alike.
    const action = legal && legal.canCheck ? ACTIONS.CHECK : ACTIONS.FOLD;
    const res = applyAction(this.hand, seat.id, action, 0);
    if (res && res.ok) {
      // Timed-out plays are announced like any other action.
      this.lastActionInfo = { seq: ++this.actionSeq, playerId: seat.id, action };
      this.afterStep();
    }
  }

  clearTurnTimer() { if (this._turnTimer) { clearTimeout(this._turnTimer); this._turnTimer = null; } this.actDeadline = null; }
  clearHandOver() { if (this._handOverTimer) { clearTimeout(this._handOverTimer); this._handOverTimer = null; } }
  clearStreetPause() { if (this._streetTimer) { clearTimeout(this._streetTimer); this._streetTimer = null; } }
  clearDropTimers() { for (const p of this.players.values()) if (p._dropTimer) { clearTimeout(p._dropTimer); p._dropTimer = null; } }
  clearTimers() { this.clearTurnTimer(); this.clearHandOver(); this.clearStreetPause(); this.clearDropTimers(); }

  // ── membership changes ──────────────────────────────────────────────────
  handleDisconnect(playerId) {
    const player = this.players.get(playerId);
    if (player) {
      player.socket = null;
      player.status = 'disconnected';
      // Start the 2-minute reconnect grace; if they don't return, the seat is
      // eliminated and can't rejoin. The turn clock (if it's their turn) keeps
      // running on its normal duration — we don't shorten or reset it.
      this.scheduleDrop(playerId);
      this.broadcast();
    } else if (this.spectators.has(playerId)) {
      this.spectators.delete(playerId);
      this.broadcast();
    }
    this.maybeDispose();
  }

  // Disconnect grace: after DROP_GRACE_MS with no reconnect, the player is
  // eliminated from the table and barred from rejoining.
  scheduleDrop(playerId) {
    const player = this.players.get(playerId);
    if (!player) return;
    if (player._dropTimer) clearTimeout(player._dropTimer);
    player._dropTimer = setTimeout(() => this.eliminateDropped(playerId), DROP_GRACE_MS);
  }

  eliminateDropped(playerId) {
    const player = this.players.get(playerId);
    if (!player || player.status === 'connected') return; // returned in time
    player._dropTimer = null;
    this.kicked.add(playerId);          // future rejoin is rejected
    this.removeMember(playerId, false); // fold out of any live hand + remove
  }

  kick(playerId) {
    if (playerId === this.hostId) return;
    this.kicked.add(playerId);
    this.removeMember(playerId, false);
  }

  removeMember(playerId, isLeave) {
    // The host leaving closes the whole table for everyone.
    if (playerId === this.hostId) { this.closeRoom(); return; }
    const player = this.players.get(playerId);
    if (player) {
      // fold them out of a live hand
      if (this.phase === PHASE.IN_HAND && this.hand) {
        const seat = this.hand.seats.find((s) => s && s.id === playerId);
        if (seat && !seat.hasFolded) {
          if (this.hand.activeSeat != null && this.hand.seats[this.hand.activeSeat]?.id === playerId) {
            applyAction(this.hand, playerId, ACTIONS.FOLD, 0);
          } else { seat.hasFolded = true; seat.inHand = false; }
        }
      }
      this.players.delete(playerId);
      if (playerId === this.hostId) {
        const next = this.seatedInOrder()[0];
        this.hostId = next ? next.id : null;
      }
      if (this.phase === PHASE.IN_HAND) this.afterStep(); else this.broadcast();
    } else {
      this.spectators.delete(playerId);
      this.broadcast();
    }
    this.maybeDispose();
  }

  maybeDispose() {
    const anyConnected = [...this.players.values()].some((p) => p.status === 'connected')
      || [...this.spectators.values()].some((s) => s.socket && s.socket.readyState === 1);
    if (!anyConnected) this.manager.disposeRoom(this);
  }

  // Host closed the table: tell everyone (so their client returns Home) and
  // tear the room down.
  closeRoom() {
    this.fanout(S2C.ERROR, { code: ERR.HOST_LEFT, message: 'The host closed the table.' });
    this.manager.disposeRoom(this);
  }

  // ── broadcasting ────────────────────────────────────────────────────────
  fanout(type, payload) {
    for (const p of this.players.values()) send(p.socket, type, payload);
    for (const s of this.spectators.values()) send(s.socket, type, payload);
  }

  broadcast() {
    for (const p of this.players.values()) send(p.socket, S2C.STATE, this.stateFor(p.id, false));
    for (const s of this.spectators.values()) send(s.socket, S2C.STATE, this.stateFor(s.id, true));
  }

  potTotal() {
    if (!this.hand) return 0;
    return this.hand.seats.reduce((sum, s) => sum + (s ? s.committed : 0), 0);
  }

  stateFor(viewerId, isSpectator) {
    const seatById = (id) => this.hand && this.hand.seats.find((s) => s && s.id === id);
    const activeId = this.hand && this.hand.activeSeat != null ? this.hand.seats[this.hand.activeSeat]?.id : null;

    // X-ray for the fallen: when the host enabled `revealToBusted`, a seated
    // player who has busted (0 chips, not dealt into the current hand) sees
    // every live hole card. They can no longer act, so nothing leaks that
    // could change the game — it's a spectator perk for eliminated friends.
    const viewerP = this.players.get(viewerId);
    const xray = !!this.settings.revealToBusted && !isSpectator
      && !!viewerP && viewerP.chips <= 0 && !seatById(viewerId);

    const players = this.seatedInOrder().map((p) => {
      const hs = seatById(p.id);
      return {
        id: p.id,
        name: p.name,
        token: p.token,
        seat: p.seat,
        chips: hs ? hs.chips : p.chips,
        status: p.status,
        isHost: p.id === this.hostId,
        ready: p.ready,
        inHand: hs ? hs.inHand : false,
        hasFolded: hs ? hs.hasFolded : false,
        isAllIn: hs ? hs.isAllIn : false,
        bet: hs ? hs.bet : 0,
        bustedHand: p.bustedHand ?? null,
        // Owner always sees their own cards; at a true showdown (hand-over with
        // 2+ live players) everyone's non-folded hole cards are revealed; and
        // busted viewers see live cards when the host allows it (xray).
        holeCards: hs && (p.id === viewerId
          || (this.phase === PHASE.HAND_OVER && this.revealAll && hs.inHand && !hs.hasFolded)
          || (xray && !hs.hasFolded))
          ? hs.holeCards : null,
        isActive: p.id === activeId,
        lastAction: hs ? hs.lastAction : null,
      };
    });

    let hand = null;
    if (this.hand && (this.phase === PHASE.IN_HAND || this.phase === PHASE.HAND_OVER)) {
      const youAct = !isSpectator && activeId === viewerId;
      hand = {
        handNumber: this.hand.handNumber,
        board: this.hand.board.slice(),
        pot: this.potTotal(),
        currentBet: this.hand.currentBet,
        minRaise: this.hand.minRaise,
        street: this.hand.street,
        activeSeat: this.hand.activeSeat,
        activePlayerId: activeId,
        actDeadline: this.actDeadline,
        // Remaining ms at send time. Clients count down from THIS (relative) so
        // a device clock that differs from the server's doesn't skew the timer.
        actMs: this.actDeadline ? Math.max(0, this.actDeadline - Date.now()) : null,
        dealerSeat: this.dealerSeat,
        sbSeat: this.hand.sbSeat,
        bbSeat: this.hand.bbSeat,
        bigBlind: this.hand.bigBlind,
        // Latest applied action { seq, playerId, action } — clients diff `seq`
        // to play the action sound/voice on EVERY device, not just the actor's.
        lastAction: this.lastActionInfo,
        legal: youAct ? legalActions(this.hand, viewerId) : null,
      };
    }

    return {
      you: {
        id: viewerId,
        seat: this.players.get(viewerId)?.seat ?? null,
        isHost: viewerId === this.hostId,
        isSpectator,
        status: this.players.get(viewerId)?.status ?? 'connected',
      },
      room: {
        code: this.code,
        phase: this.phase,
        settings: this.settings,
        hostId: this.hostId,
        spectatorCount: this.spectators.size,
      },
      players,
      hand,
      result: this.result,
      blinds: this.blinds,
      // Hand history (public info only — see endHand). Same for all viewers.
      log: this.handLog,
    };
  }
}

// next occupied seat strictly after `from` (wrapping), given sorted seat list
function nextSeatFrom(from, seats) {
  if (seats.length === 0) return -1;
  for (const s of seats) if (s > from) return s;
  return seats[0];
}
