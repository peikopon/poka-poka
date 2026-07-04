// mock-state.js — sample ClientState fixtures for serverless preview.
//
// These mirror the ClientState contract documented in server/protocol.js so the
// whole UI can be rendered and visually verified WITHOUT a running server.
// Load one with ?mock=lobby | ?mock=turn | ?mock=showdown (see app.js).
//
// Every fixture is a full ClientState snapshot as the server would tailor it for
// ONE recipient ("you"): only `you`'s holeCards are populated; everyone else's
// holeCards are null.

const STD_SETTINGS = {
  startingStack: 2500,
  smallBlind: 5,
  bigBlind: 10,
  blindsMode: 'increasing',
  maxSeats: 8,
  betting: 'no-limit',
  turnTimer: 30,
  winCondition: 'last-standing',
};

// ── Fixture 1: Lobby ─────────────────────────────────────────────────────────
// You are the host, waiting for players to ready up.
export const lobbyState = {
  you: { id: 'p1', seat: 0, isHost: true, isSpectator: false, status: 'connected' },
  room: {
    code: 'POKR',
    phase: 'lobby',
    settings: STD_SETTINGS,
    hostId: 'p1',
    spectatorCount: 2,
  },
  players: [
    mkPlayer({ id: 'p1', name: 'Mia', token: 'avatar-01', seat: 0, chips: 2500, isHost: true, ready: true }),
    mkPlayer({ id: 'p2', name: 'Theo', token: 'avatar-02', seat: 1, chips: 2500, ready: true }),
    mkPlayer({ id: 'p3', name: 'Jess', token: 'avatar-04', seat: 2, chips: 2500, ready: true }),
    mkPlayer({ id: 'p4', name: 'Sam', token: 'avatar-03', seat: 3, chips: 2500, ready: false }),
  ],
  hand: null,
  result: null,
  blinds: { level: 1, smallBlind: 5, bigBlind: 10, mode: 'increasing', handsToNext: 6 },
};

// ── Fixture 2: Your turn (in-hand) ───────────────────────────────────────────
// Mid-hand, flop is out, it is YOUR turn with a full legal descriptor so the
// redesigned action bar (sizing zone + actions) renders live.
export const turnState = {
  you: { id: 'p1', seat: 0, isHost: true, isSpectator: false, status: 'connected' },
  room: {
    code: 'POKR',
    phase: 'in-hand',
    settings: STD_SETTINGS,
    hostId: 'p1',
    spectatorCount: 1,
  },
  players: [
    mkPlayer({
      id: 'p1', name: 'Mia', token: 'avatar-01', seat: 0, chips: 2500,
      isHost: true, inHand: true, bet: 0, isActive: true,
      holeCards: ['Ad', 'Ac'],
    }),
    mkPlayer({
      id: 'p2', name: 'Theo', token: 'avatar-02', seat: 1, chips: 1820,
      inHand: true, hasFolded: true, bet: 0, lastAction: 'fold',
    }),
    mkPlayer({
      id: 'p3', name: 'Jess', token: 'avatar-04', seat: 2, chips: 1180,
      inHand: true, bet: 40, lastAction: 'raise',
    }),
    mkPlayer({
      id: 'p4', name: 'Sam', token: 'avatar-03', seat: 3, chips: 640,
      inHand: true, bet: 0, lastAction: 'check',
    }),
  ],
  hand: {
    handNumber: 12,
    board: ['As', 'Kh', '7d'],
    pot: 480,
    pots: [{ amount: 480, eligible: ['p1', 'p3', 'p4'] }],
    currentBet: 40,
    minRaise: 40,
    street: 'flop',
    activeSeat: 0,
    activePlayerId: 'p1',
    actDeadline: Date.now() + 30000,
    actMs: 30000, // relative remaining (clients anchor to their own clock)
    dealerSeat: 3,
    sbSeat: 0,
    bbSeat: 1,
    bigBlind: 10,
    legal: {
      canFold: true,
      canCheck: false,
      canCall: true,
      callAmount: 40,
      canRaise: true,
      minRaiseTo: 80,
      maxRaiseTo: 2500,
      canAllIn: true,
      allInAmount: 2500,
    },
  },
  result: null,
  blinds: { level: 1, smallBlind: 5, bigBlind: 10, mode: 'increasing', handsToNext: 4 },
  // Hand-history entries for the Log drawer: one fold-win (table cards only —
  // the winner's hand stays secret) and one true showdown (hand revealed).
  log: [
    {
      handNumber: 10,
      showdown: false,
      board: ['Qh', '8s', '3d'],
      pot: 120,
      winners: [{ id: 'p3', name: 'Jess', token: 'avatar-05', amount: 120, net: 75, handName: null, bestCards: [] }],
    },
    {
      handNumber: 11,
      showdown: true,
      board: ['Ah', 'Kd', '7s', '4c', '2d'],
      pot: 360,
      winners: [{ id: 'p1', name: 'Mia', token: 'avatar-02', amount: 360, net: 240, handName: 'Two Pair', bestCards: ['Ah', 'Ad', 'Kd', 'Kh', '7s'] }],
    },
  ],
};

// ── Fixture 3: Showdown / game over (results) ────────────────────────────────
export const showdownState = {
  you: { id: 'p1', seat: 0, isHost: true, isSpectator: false, status: 'connected' },
  room: {
    code: 'POKR',
    phase: 'game-over',
    settings: STD_SETTINGS,
    hostId: 'p1',
    spectatorCount: 0,
  },
  players: [
    mkPlayer({ id: 'p1', name: 'Mia', token: 'avatar-01', seat: 0, chips: 1240, isHost: true }),
    mkPlayer({ id: 'p2', name: 'Theo', token: 'avatar-02', seat: 1, chips: 820 }),
    mkPlayer({ id: 'p3', name: 'Jess', token: 'avatar-04', seat: 2, chips: 0 }),
  ],
  hand: {
    handNumber: 18,
    board: ['Ks', '9c', '9d', '2h', 'Qs'],
    pot: 0,
    pots: [],
    currentBet: 0,
    minRaise: 10,
    street: 'showdown',
    activeSeat: -1,
    activePlayerId: null,
    actDeadline: null,
    dealerSeat: 0,
    legal: null,
  },
  result: {
    winners: [
      {
        id: 'p1',
        name: 'Mia',
        amount: 1240,
        handName: 'Full House',
        bestCards: ['Ks', 'Kh', 'Kd', '9c', '9d'],
      },
    ],
    board: ['Ks', '9c', '9d', '2h', 'Qs'],
  },
  blinds: { level: 2, smallBlind: 10, bigBlind: 20, mode: 'increasing', handsToNext: 2 },
};

// ── Helper: build a PlayerView with sensible defaults ─────────────────────────
function mkPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    token: p.token,
    seat: p.seat,
    chips: p.chips ?? 0,
    status: p.status ?? 'connected',
    isHost: p.isHost ?? false,
    inHand: p.inHand ?? false,
    hasFolded: p.hasFolded ?? false,
    isAllIn: p.isAllIn ?? false,
    bet: p.bet ?? 0,
    holeCards: p.holeCards ?? null,
    isActive: p.isActive ?? false,
    lastAction: p.lastAction ?? null,
    // `ready` is a lobby-only convenience flag (not in the formal PlayerView,
    // but the lobby renders it). The real server would carry equivalent info.
    ready: p.ready ?? false,
  };
}

// ── Fixture 4: Hand-over reveal (table showdown banner) ──────────────────────
// Phase 'hand-over' with a true showdown: opponents' cards are revealed and the
// winner banner overlays the felt.
export const handoverState = {
  you: { id: 'p1', seat: 0, isHost: true, isSpectator: false, status: 'connected' },
  room: { code: 'POKR', phase: 'hand-over', settings: STD_SETTINGS, hostId: 'p1', spectatorCount: 0 },
  players: [
    mkPlayer({ id: 'p1', name: 'Mia', token: 'avatar-01', seat: 0, chips: 3200, isHost: true, inHand: true, holeCards: ['Ad', 'Ac'] }),
    mkPlayer({ id: 'p3', name: 'Jess', token: 'avatar-04', seat: 2, chips: 800, inHand: true, holeCards: ['Ks', 'Qh'] }),
  ],
  hand: {
    handNumber: 12, board: ['As', 'Kh', '7d', '2c', '9s'], pot: 0, pots: [],
    currentBet: 0, minRaise: 10, street: 'showdown', activeSeat: -1, activePlayerId: null,
    actDeadline: null, dealerSeat: 2, sbSeat: 2, bbSeat: 0, bigBlind: 10, legal: null,
  },
  result: {
    showdown: true,
    winners: [{ id: 'p1', name: 'Mia', amount: 1240, handName: 'Three of a Kind', bestCards: ['Ad', 'Ac', 'As', 'Kh', '9s'] }],
    board: ['As', 'Kh', '7d', '2c', '9s'],
  },
  blinds: { level: 1, smallBlind: 5, bigBlind: 10, mode: 'increasing', handsToNext: 3 },
};

export const MOCKS = {
  lobby: lobbyState,
  turn: turnState,
  showdown: showdownState,
  handover: handoverState,
};
