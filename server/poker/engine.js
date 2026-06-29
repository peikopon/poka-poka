// engine.js — PURE No-Limit Texas Hold'em hand lifecycle.
//
// No timers, IO, console, or sockets. The room manager owns those and drives
// these functions. A hand is a plain object (see the `hand` typedef below).
// All randomness is injectable via the optional `deck` argument to startHand.

import { freshDeck, shuffle } from './deck.js';
import { evaluate7, compareHands } from './hand-rank.js';
import { buildSidePots } from './pot.js';

const STREETS = ['preflop', 'flop', 'turn', 'river', 'showdown'];

/**
 * Begin a new hand.
 * @param {Array<{id:string, seat:number, chips:number}>} seatedPlayers players with chips>0.
 * @param {{smallBlind:number, bigBlind:number}} settings
 * @param {number} dealerSeat seat index of the button.
 * @param {string[]} [deck] optional pre-shuffled deck (for determinism/tests).
 * @returns {object} hand
 */
export function startHand(seatedPlayers, settings, dealerSeat, deck) {
  const sb = settings.smallBlind;
  const bb = settings.bigBlind;

  // Determine seat array size: max seat index among players + 1.
  const maxSeat = seatedPlayers.reduce((m, p) => Math.max(m, p.seat), 0);
  const seats = new Array(maxSeat + 1).fill(null);
  for (const p of seatedPlayers) {
    seats[p.seat] = {
      id: p.id,
      inHand: true,
      hasFolded: false,
      isAllIn: false,
      chips: p.chips,
      bet: 0,
      committed: 0,
      holeCards: [],
      lastAction: null,
    };
  }

  const liveSeats = occupiedSeats(seats);
  const heedsUp = liveSeats.length === 2;
  const useDeck = (deck ? deck.slice() : shuffle(freshDeck())).slice();

  // Blind positions.
  let sbSeat;
  let bbSeat;
  if (heedsUp) {
    // Heads-up: button posts the small blind.
    sbSeat = dealerSeat;
    bbSeat = nextOccupied(seats, dealerSeat);
  } else {
    sbSeat = nextOccupied(seats, dealerSeat);
    bbSeat = nextOccupied(seats, sbSeat);
  }

  const hand = {
    handNumber: 0,
    dealerSeat,
    sbSeat,
    bbSeat,
    smallBlind: sb,
    bigBlind: bb,
    street: 'preflop',
    board: [],
    deck: useDeck,
    currentBet: bb,
    minRaise: bb,
    activeSeat: null,
    seats,
  };

  // Deal 2 hole cards each, starting left of the button, one at a time.
  for (let round = 0; round < 2; round++) {
    let seat = nextOccupied(seats, dealerSeat);
    for (let i = 0; i < liveSeats.length; i++) {
      seats[seat].holeCards.push(hand.deck.shift());
      seat = nextOccupied(seats, seat);
    }
  }

  // Post blinds.
  postBlind(seats[sbSeat], sb);
  postBlind(seats[bbSeat], bb);

  // First to act preflop: left of the big blind (heads-up: the SB/button).
  if (heedsUp) {
    hand.activeSeat = sbSeat;
  } else {
    hand.activeSeat = nextOccupied(seats, bbSeat);
  }
  // Skip any all-in seats (e.g. a blind that put a player all-in).
  hand.activeSeat = ensureActable(hand, hand.activeSeat);

  return hand;
}

/** Post (up to) `amount` as a blind; may put a short stack all-in. */
function postBlind(seat, amount) {
  const pay = Math.min(amount, seat.chips);
  seat.chips -= pay;
  seat.bet += pay;
  seat.committed += pay;
  if (seat.chips === 0) seat.isAllIn = true;
}

/**
 * Legal actions for the player to act.
 * @returns {import('../protocol.js').Legal}
 */
export function legalActions(hand, playerId) {
  const seatIdx = seatOf(hand, playerId);
  const seat = seatIdx == null ? null : hand.seats[seatIdx];
  const noLegal = {
    canFold: false,
    canCheck: false,
    canCall: false,
    callAmount: 0,
    canRaise: false,
    minRaiseTo: 0,
    maxRaiseTo: 0,
    canAllIn: false,
    allInAmount: 0,
  };
  if (!seat || seatIdx !== hand.activeSeat || seat.hasFolded || seat.isAllIn || !seat.inHand) {
    return noLegal;
  }

  const toCall = Math.max(0, hand.currentBet - seat.bet);
  const callAmount = Math.min(toCall, seat.chips);
  const canCheck = toCall === 0;
  const canCall = toCall > 0 && seat.chips > 0;

  // Raise sizing. minRaiseTo = currentBet + last full raise size.
  const maxRaiseTo = seat.bet + seat.chips; // shove all-in
  let minRaiseTo = hand.currentBet + hand.minRaise;
  if (minRaiseTo > maxRaiseTo) minRaiseTo = maxRaiseTo;
  // Can only raise if we have chips beyond the call, i.e. maxRaiseTo > currentBet.
  const canRaise = seat.chips > 0 && maxRaiseTo > hand.currentBet;
  const canAllIn = seat.chips > 0;

  return {
    canFold: true,
    canCheck,
    canCall,
    callAmount,
    canRaise,
    minRaiseTo: canRaise ? minRaiseTo : 0,
    maxRaiseTo: canRaise ? maxRaiseTo : 0,
    canAllIn,
    allInAmount: maxRaiseTo,
  };
}

/**
 * Apply a player's action. Mutates `hand` in place.
 * @param {object} hand
 * @param {string} playerId
 * @param {'fold'|'check'|'call'|'raise'|'allin'} action
 * @param {number} [amount] for 'raise': total "raise to" for the street.
 * @returns {{ok:boolean, error?:string, events?:any[]}}
 */
export function applyAction(hand, playerId, action, amount) {
  const seatIdx = seatOf(hand, playerId);
  if (seatIdx == null) return fail('player_not_found');
  if (seatIdx !== hand.activeSeat) return fail('not_your_turn');

  const seat = hand.seats[seatIdx];
  if (!seat.inHand || seat.hasFolded || seat.isAllIn) return fail('not_your_turn');

  const legal = legalActions(hand, playerId);
  const events = [];

  switch (action) {
    case 'fold': {
      seat.hasFolded = true;
      seat.inHand = false;
      seat.lastAction = 'fold';
      events.push({ type: 'fold', id: playerId });
      break;
    }
    case 'check': {
      if (!legal.canCheck) return fail('illegal_action');
      seat.lastAction = 'check';
      events.push({ type: 'check', id: playerId });
      break;
    }
    case 'call': {
      if (!legal.canCall) return fail('illegal_action');
      const pay = legal.callAmount;
      commit(seat, pay);
      seat.lastAction = 'call';
      events.push({ type: 'call', id: playerId, amount: pay });
      break;
    }
    case 'raise':
    case 'allin': {
      let raiseTo;
      if (action === 'allin') {
        raiseTo = seat.bet + seat.chips;
      } else {
        if (!legal.canRaise) return fail('illegal_action');
        raiseTo = amount;
        if (!Number.isFinite(raiseTo)) return fail('illegal_action');
        // Must be at least min-raise (unless it is an all-in shove for less,
        // which is only reachable via the 'allin' action, not 'raise').
        if (raiseTo < legal.minRaiseTo) return fail('illegal_action');
        if (raiseTo > legal.maxRaiseTo) return fail('illegal_action');
      }

      // Must put more chips in than the current bet to be a raise/bet; a pure
      // all-in call (raiseTo <= currentBet) is handled as a call.
      const isAllInShove = action === 'allin' && raiseTo === seat.bet + seat.chips;

      if (raiseTo <= hand.currentBet) {
        // All-in for less than a call (or exactly a call) — treat as a call.
        if (!isAllInShove) return fail('illegal_action');
        const pay = Math.min(Math.max(0, hand.currentBet - seat.bet), seat.chips);
        commit(seat, pay);
        seat.lastAction = 'call';
        events.push({ type: 'call', id: playerId, amount: pay, allIn: seat.isAllIn });
        break;
      }

      const raiseSize = raiseTo - hand.currentBet;
      const pay = raiseTo - seat.bet;
      commit(seat, pay);

      const isFullRaise = raiseSize >= hand.minRaise;
      if (isFullRaise) {
        // Full raise reopens betting and sets the new min-raise size.
        hand.minRaise = raiseSize;
        hand.currentBet = raiseTo;
        seat.lastAction = action === 'allin' ? 'allin' : 'raise';
        reopenAction(hand, seatIdx);
        events.push({ type: 'raise', id: playerId, to: raiseTo, allIn: seat.isAllIn });
      } else {
        // Under-full all-in raise: raises the bet level but does NOT reopen
        // action for players who already acted.
        hand.currentBet = raiseTo;
        seat.lastAction = 'allin';
        events.push({ type: 'raise', id: playerId, to: raiseTo, allIn: seat.isAllIn, short: true });
      }
      break;
    }
    default:
      return fail('illegal_action');
  }

  // Advance to the next player who still needs to act.
  hand.activeSeat = nextToAct(hand, seatIdx);
  return { ok: true, events };
}

/** Commit `pay` chips from a seat's stack into the pot for this street. */
function commit(seat, pay) {
  const p = Math.min(pay, seat.chips);
  seat.chips -= p;
  seat.bet += p;
  seat.committed += p;
  if (seat.chips === 0) seat.isAllIn = true;
}

/**
 * Mark all other still-in, non-all-in players as needing to act again after a
 * full raise. We model "needs to act" implicitly via lastAction: clear it for
 * everyone except the raiser so nextToAct will revisit them.
 */
function reopenAction(hand, raiserIdx) {
  hand.seats.forEach((s, i) => {
    if (!s || i === raiserIdx) return;
    if (s.inHand && !s.hasFolded && !s.isAllIn) {
      s.actedThisRound = false;
    }
  });
  hand.seats[raiserIdx].actedThisRound = true;
}

/**
 * Compute the next seat that must act, or null if the round is complete.
 * A seat must act if it is in the hand, not folded, not all-in, and either
 * hasn't acted this round or hasn't matched the current bet.
 */
function nextToAct(hand, fromIdx) {
  // Mark the seat that just acted.
  if (hand.seats[fromIdx]) hand.seats[fromIdx].actedThisRound = true;

  // If only one (or zero) player remains in the hand, betting is over.
  let stillIn = 0;
  for (const s of hand.seats) {
    if (s && s.inHand && !s.hasFolded) stillIn++;
  }
  if (stillIn <= 1) return null;

  const n = hand.seats.length;
  for (let step = 1; step <= n; step++) {
    const idx = (fromIdx + step) % n;
    const s = hand.seats[idx];
    if (!s || !s.inHand || s.hasFolded || s.isAllIn) continue;
    const needsToMatch = s.bet < hand.currentBet;
    const hasActed = s.actedThisRound === true;
    if (needsToMatch || !hasActed) return idx;
  }
  return null;
}

/** Find the next actable (in-hand, not all-in) seat at or after `startIdx`. */
function ensureActable(hand, startIdx) {
  if (startIdx == null) return null;
  const n = hand.seats.length;
  for (let step = 0; step < n; step++) {
    const idx = (startIdx + step) % n;
    const s = hand.seats[idx];
    if (s && s.inHand && !s.hasFolded && !s.isAllIn) {
      // First-to-act preflop has not acted yet.
      return idx;
    }
  }
  return null;
}

/** True when the current betting round is complete. */
export function isBettingRoundComplete(hand) {
  return hand.activeSeat == null;
}

/**
 * Advance exactly one street: preflop->flop->turn->river->showdown.
 * Burns + deals board cards, resets street bets, sets first-to-act.
 * @returns {{street:string, dealt:string[], showdown:boolean}}
 */
export function advanceStreet(hand) {
  const cur = STREETS.indexOf(hand.street);
  const nextStreet = STREETS[cur + 1];
  const dealt = [];

  if (nextStreet === 'flop') {
    hand.deck.shift(); // burn
    dealt.push(hand.deck.shift(), hand.deck.shift(), hand.deck.shift());
  } else if (nextStreet === 'turn' || nextStreet === 'river') {
    hand.deck.shift(); // burn
    dealt.push(hand.deck.shift());
  }
  hand.board.push(...dealt);
  hand.street = nextStreet;

  // Reset per-street state.
  hand.currentBet = 0;
  hand.minRaise = hand.bigBlind;
  for (const s of hand.seats) {
    if (!s) continue;
    s.bet = 0;
    s.actedThisRound = false;
    if (s.inHand && !s.hasFolded && s.lastAction !== 'fold') s.lastAction = null;
  }

  if (nextStreet === 'showdown') {
    hand.activeSeat = null;
    return { street: nextStreet, dealt, showdown: true };
  }

  // First to act post-flop: first active seat left of the dealer.
  let first = ensureActable(hand, nextOccupied(hand.seats, hand.dealerSeat));
  // If 0 or 1 players can still act (all others all-in / folded), no betting.
  if (countActable(hand) < 2) first = null;
  hand.activeSeat = first;

  return { street: nextStreet, dealt, showdown: false };
}

/**
 * Settle the hand: build side pots from committed chips, evaluate hands, and
 * distribute. Does NOT mutate player stacks — returns payouts for the room.
 * @param {object} hand
 * @param {Record<string,{name:string}>} playersById
 * @returns {{winners:Array<{id,name,amount,handName,bestCards:string[]}>, payouts:Record<string,number>}}
 */
export function settle(hand, playersById) {
  const contribs = {};
  const foldedIds = [];
  const idToSeat = {};
  for (const s of hand.seats) {
    if (!s) continue;
    if (s.committed > 0) contribs[s.id] = s.committed;
    if (s.hasFolded) foldedIds.push(s.id);
    idToSeat[s.id] = s;
  }

  const pots = buildSidePots(contribs, foldedIds);
  const payouts = {};
  const winnerAgg = {}; // id -> {amount, handName, bestCards}

  // Pre-evaluate showdown hands for non-folded players.
  const evalCache = {};
  const handNameById = {};
  const bestCardsById = {};
  for (const s of hand.seats) {
    if (!s || s.hasFolded || !s.committed) continue;
    if (s.holeCards.length === 2 && hand.board.length >= 3) {
      const ev = evaluate7([...s.holeCards, ...hand.board]);
      evalCache[s.id] = ev;
      handNameById[s.id] = ev.name;
      bestCardsById[s.id] = ev.best5;
    }
  }

  // Order seats by closeness to the left of the dealer (for odd-chip awarding).
  const orderForOddChip = seatsLeftOfDealer(hand);

  for (const pot of pots) {
    const eligible = pot.eligible;
    if (eligible.length === 0) continue;

    let winners;
    if (eligible.length === 1) {
      winners = [eligible[0]];
    } else {
      // Determine best hand among eligible.
      let best = null;
      winners = [];
      for (const id of eligible) {
        const ev = evalCache[id];
        if (!ev) continue;
        if (best == null) {
          best = ev;
          winners = [id];
        } else {
          const cmp = compareHands(ev, best);
          if (cmp > 0) {
            best = ev;
            winners = [id];
          } else if (cmp === 0) {
            winners.push(id);
          }
        }
      }
      if (winners.length === 0) winners = eligible.slice();
    }

    // Split the pot; odd chip to the earliest seat left of the dealer.
    const share = Math.floor(pot.amount / winners.length);
    let remainder = pot.amount - share * winners.length;
    const orderedWinners = orderForOddChip.filter((id) => winners.includes(id));
    for (const id of orderedWinners) {
      let amt = share;
      if (remainder > 0) {
        amt += 1;
        remainder -= 1;
      }
      payouts[id] = (payouts[id] || 0) + amt;
      if (!winnerAgg[id]) {
        winnerAgg[id] = {
          amount: 0,
          handName: handNameById[id] || null,
          bestCards: bestCardsById[id] || [],
        };
      }
      winnerAgg[id].amount += amt;
    }
  }

  const winners = Object.keys(winnerAgg).map((id) => ({
    id,
    name: (playersById && playersById[id] && playersById[id].name) || id,
    amount: winnerAgg[id].amount,
    handName: winnerAgg[id].handName,
    bestCards: winnerAgg[id].bestCards,
  }));

  return { winners, payouts };
}

// ── seat helpers ─────────────────────────────────────────────────────────────

function fail(error) {
  return { ok: false, error };
}

function occupiedSeats(seats) {
  const out = [];
  seats.forEach((s, i) => {
    if (s) out.push(i);
  });
  return out;
}

/** Next occupied seat index strictly after `idx` (wrapping). */
function nextOccupied(seats, idx) {
  const n = seats.length;
  for (let step = 1; step <= n; step++) {
    const i = (idx + step) % n;
    if (seats[i]) return i;
  }
  return idx;
}

function seatOf(hand, playerId) {
  for (let i = 0; i < hand.seats.length; i++) {
    if (hand.seats[i] && hand.seats[i].id === playerId) return i;
  }
  return null;
}

function countActable(hand) {
  let c = 0;
  for (const s of hand.seats) {
    if (s && s.inHand && !s.hasFolded && !s.isAllIn) c++;
  }
  return c;
}

/** Ordered list of player ids by seat distance to the left of the dealer. */
function seatsLeftOfDealer(hand) {
  const out = [];
  const n = hand.seats.length;
  for (let step = 1; step <= n; step++) {
    const i = (hand.dealerSeat + step) % n;
    const s = hand.seats[i];
    if (s) out.push(s.id);
  }
  return out;
}
