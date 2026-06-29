// Poka-Poka — shared WebSocket protocol + game-state contract.
//
// This file is the single source of truth for the client/server message shapes
// and the per-recipient game-state snapshot. The poker engine, the room manager,
// and the front-end all conform to the types documented here.
//
// ── Card encoding ────────────────────────────────────────────────────────────
// A card is a 2-char string: rank + suit.
//   ranks: '2'..'9', 'T', 'J', 'Q', 'K', 'A'
//   suits: 's' (spade), 'h' (heart), 'd' (diamond), 'c' (club)
//   e.g. 'As' = ace of spades, 'Td' = ten of diamonds, '9c' = nine of clubs.
//
// ── Client → server messages ({ type, ...payload }) ──────────────────────────
//   create   { settings, name, token }          host creates a table (with identity)
//   join     { code, name, token }             player joins a room
//   rejoin   { code, playerId }                reconnect to held seat
//   spectate { code }                          watch (no seat)
//   ready    {}                                toggle ready in lobby
//   start    {}                                host starts the game
//   action   { action, amount? }               betting decision on your turn
//   chat     { text }                          chat message
//   react    { emote }                         emote / reaction
//   kick     { playerId }                      host removes a player
//   leave    {}                                leave the table
//
// ── Server → client messages ─────────────────────────────────────────────────
//   state      ClientState   authoritative snapshot, tailored per recipient
//   joined     { playerId, code }
//   error      { code, message }
//   chat       { id, name, token, text, ts }
//   react      { id, emote, ts }
//   handResult { winners, board }              (also carried inside ClientState.result)

export const C2S = Object.freeze({
  CREATE: 'create',
  JOIN: 'join',
  REJOIN: 'rejoin',
  SPECTATE: 'spectate',
  READY: 'ready',
  START: 'start',
  ACTION: 'action',
  CHAT: 'chat',
  REACT: 'react',
  KICK: 'kick',
  LEAVE: 'leave',
  FINISH: 'finish', // host ends the whole game (→ results)
  PEEK: 'peek',     // pre-join: ask which avatars are already taken in a room
});

export const S2C = Object.freeze({
  STATE: 'state',
  JOINED: 'joined',
  ERROR: 'error',
  CHAT: 'chat',
  REACT: 'react',
  HAND_RESULT: 'handResult',
  ROOM_INFO: 'roomInfo', // reply to PEEK: { code, exists, takenTokens }
});

export const ACTIONS = Object.freeze({
  FOLD: 'fold',
  CHECK: 'check',
  CALL: 'call',
  RAISE: 'raise', // amount = total "raise to" amount for the street
  ALLIN: 'allin',
});

export const PHASE = Object.freeze({
  LOBBY: 'lobby',
  IN_HAND: 'in-hand',
  HAND_OVER: 'hand-over',
  GAME_OVER: 'game-over',
});

export const STREET = Object.freeze({
  PREFLOP: 'preflop',
  FLOP: 'flop',
  TURN: 'turn',
  RIVER: 'river',
  SHOWDOWN: 'showdown',
});

export const ERR = Object.freeze({
  BAD_MESSAGE: 'bad_message',
  ROOM_NOT_FOUND: 'room_not_found',
  ROOM_FULL: 'room_full',
  NAME_TAKEN: 'name_taken',
  NOT_HOST: 'not_host',
  NOT_YOUR_TURN: 'not_your_turn',
  ILLEGAL_ACTION: 'illegal_action',
  ALREADY_STARTED: 'already_started',
  KICKED: 'kicked',
  PLAYER_NOT_FOUND: 'player_not_found',
  HOST_LEFT: 'host_left', // the host closed the table
});

// Selectable player tokens — the kawaii fruit-hat avatars from the icon sprite.
export const TOKENS = Object.freeze([
  'avatar-01', 'avatar-02', 'avatar-03', 'avatar-04', 'avatar-05',
  'avatar-06', 'avatar-07', 'avatar-08', 'avatar-09',
]);

export const EMOTES = Object.freeze(['👏', '😎', '🔥', '😱', 'GG']);

// ── Host-configurable table settings (from the Host "game rules" mockup) ──────
export const SETTING_OPTIONS = Object.freeze({
  startingStack: [500, 1000, 2500, 5000],
  blinds: [
    { sb: 1, bb: 2 },
    { sb: 5, bb: 10 },
    { sb: 25, bb: 50 },
    { sb: 50, bb: 100 },
  ],
  blindsMode: ['increasing', 'fixed'],
  maxSeats: { min: 2, max: 8 },
  betting: ['no-limit'], // v1: No-Limit only
  turnTimer: [15, 30, 60, 0], // 0 = off
  winCondition: ['last-standing', 'host-ends'],
});

export const DEFAULT_SETTINGS = Object.freeze({
  startingStack: 2500,
  smallBlind: 5,
  bigBlind: 10,
  blindsMode: 'increasing',
  maxSeats: 8,
  betting: 'no-limit',
  turnTimer: 30,
  winCondition: 'last-standing',
});

// "Increasing" blinds go up by progress, NOT a wall-clock timer: one level
// every BLIND_LEVEL_HANDS hands, and immediately whenever a player is
// eliminated (busts out). BLIND_LEVEL_MS is retained only for back-compat.
export const BLIND_LEVEL_MS = 5 * 60 * 1000;
export const BLIND_LEVEL_HANDS = 6;

/**
 * @typedef {Object} Settings
 * @property {number} startingStack
 * @property {number} smallBlind
 * @property {number} bigBlind
 * @property {'increasing'|'fixed'} blindsMode
 * @property {number} maxSeats
 * @property {'no-limit'} betting
 * @property {number} turnTimer  seconds; 0 = off
 * @property {'last-standing'|'host-ends'} winCondition
 */

/**
 * Legal-action descriptor sent to the player who is to act.
 * @typedef {Object} Legal
 * @property {boolean} canFold
 * @property {boolean} canCheck
 * @property {boolean} canCall
 * @property {number}  callAmount   chips needed to call (additional to current bet)
 * @property {boolean} canRaise
 * @property {number}  minRaiseTo   minimum legal "raise to" total for the street
 * @property {number}  maxRaiseTo   maximum "raise to" (== stack-limited all-in)
 * @property {boolean} canAllIn
 * @property {number}  allInAmount  total street bet if shoving all-in
 */

/**
 * A player as seen in ClientState.players (seat order). `holeCards` is only
 * populated for the recipient ("you"); for everyone else it is null.
 * @typedef {Object} PlayerView
 * @property {string}  id
 * @property {string}  name
 * @property {string}  token        avatar id
 * @property {number}  seat
 * @property {number}  chips        stack NOT in the pot
 * @property {'connected'|'disconnected'} status
 * @property {boolean} isHost
 * @property {boolean} inHand       dealt into the current hand
 * @property {boolean} hasFolded
 * @property {boolean} isAllIn
 * @property {number}  bet          chips committed on the current street
 * @property {(string[]|null)} holeCards   only for "you"
 * @property {boolean} isActive     whose turn it is
 * @property {(string|null)} lastAction
 */

/**
 * The authoritative snapshot the server sends to ONE recipient.
 * @typedef {Object} ClientState
 * @property {Object} you      { id, seat, isHost, isSpectator, status }
 * @property {Object} room     { code, phase, settings, hostId, spectatorCount }
 * @property {PlayerView[]} players
 * @property {Object|null} hand {
 *     handNumber, board:string[], pot:number,
 *     pots:{amount:number,eligible:string[]}[],
 *     currentBet:number, minRaise:number, street, activeSeat, activePlayerId,
 *     actDeadline:(number|null),   // epoch ms for the turn timer
 *     dealerSeat,
 *     legal:(Legal|null)           // populated only when it's "you" to act
 *   }
 * @property {Object|null} result {
 *     winners:{id,name,amount,handName,bestCards:string[]}[],
 *     board:string[]
 *   }
 * @property {Object} blinds   { level, smallBlind, bigBlind, nextLevelAt:(number|null) }
 */

// ── Validation helpers ───────────────────────────────────────────────────────

export function normalizeName(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, 16);
}

export function isValidToken(token) {
  return TOKENS.includes(token);
}

/** Coerce arbitrary host input into a valid, safe Settings object. */
export function sanitizeSettings(input = {}) {
  const o = { ...DEFAULT_SETTINGS };
  const pick = (val, allowed, fallback) => (allowed.includes(val) ? val : fallback);

  o.startingStack = pick(input.startingStack, SETTING_OPTIONS.startingStack, o.startingStack);

  const blinds = SETTING_OPTIONS.blinds.find(
    (b) => b.sb === input.smallBlind && b.bb === input.bigBlind,
  );
  if (blinds) {
    o.smallBlind = blinds.sb;
    o.bigBlind = blinds.bb;
  }

  o.blindsMode = pick(input.blindsMode, SETTING_OPTIONS.blindsMode, o.blindsMode);
  o.betting = pick(input.betting, SETTING_OPTIONS.betting, o.betting);
  o.turnTimer = pick(input.turnTimer, SETTING_OPTIONS.turnTimer, o.turnTimer);
  o.winCondition = pick(input.winCondition, SETTING_OPTIONS.winCondition, o.winCondition);

  const seats = Number(input.maxSeats);
  o.maxSeats = Number.isInteger(seats)
    ? Math.min(SETTING_OPTIONS.maxSeats.max, Math.max(SETTING_OPTIONS.maxSeats.min, seats))
    : o.maxSeats;

  return o;
}

/** Basic envelope check for an inbound client message. Returns true if usable. */
export function isClientMessage(msg) {
  return msg && typeof msg === 'object' && typeof msg.type === 'string';
}

export function isAction(a) {
  return Object.values(ACTIONS).includes(a);
}
