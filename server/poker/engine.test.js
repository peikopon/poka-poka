import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  startHand,
  legalActions,
  applyAction,
  isBettingRoundComplete,
  advanceStreet,
  settle,
} from './engine.js';

const SETTINGS = { smallBlind: 5, bigBlind: 10 };

// Build a deterministic deck. Hole cards are dealt left-of-button, one at a
// time, two rounds. Then board burns/cards follow. We construct decks so the
// deal order is predictable for 3-handed games (dealer seat 0 => deal order
// seats 1,2,0 then 1,2,0).
function deck(...cards) {
  return cards;
}

test('startHand posts blinds and sets preflop action (3-handed)', () => {
  const players = [
    { id: 'A', seat: 0, chips: 1000 },
    { id: 'B', seat: 1, chips: 1000 },
    { id: 'C', seat: 2, chips: 1000 },
  ];
  const hand = startHand(players, SETTINGS, 0, makeDeck());
  // SB = seat 1, BB = seat 2, first to act = seat 0 (UTG / left of BB).
  assert.equal(hand.seats[1].bet, 5);
  assert.equal(hand.seats[2].bet, 10);
  assert.equal(hand.currentBet, 10);
  assert.equal(hand.activeSeat, 0);
  assert.equal(hand.seats[0].holeCards.length, 2);
});

test('heads-up: button posts small blind and acts first preflop', () => {
  const players = [
    { id: 'A', seat: 0, chips: 1000 },
    { id: 'B', seat: 1, chips: 1000 },
  ];
  const hand = startHand(players, SETTINGS, 0, makeDeck());
  // Heads-up: dealer (seat 0) posts SB, seat 1 posts BB, SB acts first.
  assert.equal(hand.seats[0].bet, 5);
  assert.equal(hand.seats[1].bet, 10);
  assert.equal(hand.activeSeat, 0);
});

test('reject acting out of turn', () => {
  const players = [
    { id: 'A', seat: 0, chips: 1000 },
    { id: 'B', seat: 1, chips: 1000 },
    { id: 'C', seat: 2, chips: 1000 },
  ];
  const hand = startHand(players, SETTINGS, 0, makeDeck());
  // It is seat 0 (A) to act; B acting is illegal.
  const r = applyAction(hand, 'B', 'check');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'not_your_turn');
});

test('reject raise below min-raise', () => {
  const players = [
    { id: 'A', seat: 0, chips: 1000 },
    { id: 'B', seat: 1, chips: 1000 },
    { id: 'C', seat: 2, chips: 1000 },
  ];
  const hand = startHand(players, SETTINGS, 0, makeDeck());
  // currentBet 10, minRaise 10 => minRaiseTo 20. A raises to 15 (illegal).
  const r = applyAction(hand, 'A', 'raise', 15);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'illegal_action');
  // A raise to 20 is legal.
  const r2 = applyAction(hand, 'A', 'raise', 20);
  assert.equal(r2.ok, true);
  assert.equal(hand.currentBet, 20);
});

test('full 3-handed hand played to showdown', () => {
  const players = [
    { id: 'A', seat: 0, chips: 1000 },
    { id: 'B', seat: 1, chips: 1000 },
    { id: 'C', seat: 2, chips: 1000 },
  ];
  // Deal order (dealer 0): seats 1,2,0 then 1,2,0.
  // seat1(B): As, Ad   seat2(C): Ks, Kd   seat0(A): 2c, 7d
  // burn, flop: Ah Qs Js ; burn, turn: 3c ; burn, river: 4d
  const d = deck(
    'As', 'Ks', '2c', // round 1: B, C, A
    'Ad', 'Kd', '7d', // round 2: B, C, A
    'Xx', // burn
    'Ah', 'Qs', 'Js', // flop
    'Yy', // burn
    '3c', // turn
    'Zz', // burn
    '4d', // river
  );
  const hand = startHand(players, SETTINGS, 0, d);

  // Preflop: A (seat0) calls 10, B (seat1, SB) calls, C (seat2, BB) checks.
  assert.equal(hand.activeSeat, 0);
  assert.equal(applyAction(hand, 'A', 'call').ok, true);
  assert.equal(hand.activeSeat, 1);
  assert.equal(applyAction(hand, 'B', 'call').ok, true);
  assert.equal(hand.activeSeat, 2);
  assert.equal(applyAction(hand, 'C', 'check').ok, true);
  assert.ok(isBettingRoundComplete(hand));

  // Flop
  let adv = advanceStreet(hand);
  assert.equal(adv.street, 'flop');
  assert.deepEqual(hand.board, ['Ah', 'Qs', 'Js']);
  // First to act post-flop: left of dealer = seat 1 (B).
  assert.equal(hand.activeSeat, 1);
  assert.equal(applyAction(hand, 'B', 'check').ok, true);
  assert.equal(applyAction(hand, 'C', 'check').ok, true);
  assert.equal(applyAction(hand, 'A', 'check').ok, true);
  assert.ok(isBettingRoundComplete(hand));

  // Turn
  adv = advanceStreet(hand);
  assert.equal(adv.street, 'turn');
  assert.equal(applyAction(hand, 'B', 'check').ok, true);
  assert.equal(applyAction(hand, 'C', 'check').ok, true);
  assert.equal(applyAction(hand, 'A', 'check').ok, true);

  // River
  adv = advanceStreet(hand);
  assert.equal(adv.street, 'river');
  assert.equal(applyAction(hand, 'B', 'check').ok, true);
  assert.equal(applyAction(hand, 'C', 'check').ok, true);
  assert.equal(applyAction(hand, 'A', 'check').ok, true);

  // Showdown
  adv = advanceStreet(hand);
  assert.equal(adv.showdown, true);

  const { winners, payouts } = settle(hand, {
    A: { name: 'A' }, B: { name: 'B' }, C: { name: 'C' },
  });
  // B has trip aces (AAA + Ah on board) -> full house Aces full of... actually
  // board Ah Qs Js 3c 4d. B: As Ad + Ah = trip aces, kickers Q J.
  // C: Ks Kd -> two pair? Ah on board, K K + AA? no. C has KK + board pair none
  // -> pair of kings... actually B (trip aces) wins.
  assert.equal(winners.length, 1);
  assert.equal(winners[0].id, 'B');
  assert.equal(payouts['B'], 30);
});

test('hand ends when everyone folds to one player', () => {
  const players = [
    { id: 'A', seat: 0, chips: 1000 },
    { id: 'B', seat: 1, chips: 1000 },
    { id: 'C', seat: 2, chips: 1000 },
  ];
  const hand = startHand(players, SETTINGS, 0, makeDeck());
  // A folds, B (SB) folds, C (BB) wins uncontested.
  assert.equal(applyAction(hand, 'A', 'fold').ok, true);
  assert.equal(applyAction(hand, 'B', 'fold').ok, true);
  assert.ok(isBettingRoundComplete(hand));

  const { winners, payouts } = settle(hand, {
    A: { name: 'A' }, B: { name: 'B' }, C: { name: 'C' },
  });
  assert.equal(winners.length, 1);
  assert.equal(winners[0].id, 'C');
  // Pot = SB(5) + BB(10) = 15, all to C.
  assert.equal(payouts['C'], 15);
});

test('all-in creates a side pot and settles correctly', () => {
  const players = [
    { id: 'A', seat: 0, chips: 100 },  // short stack
    { id: 'B', seat: 1, chips: 1000 },
    { id: 'C', seat: 2, chips: 1000 },
  ];
  // Deal order (dealer 0): seats 1,2,0 then 1,2,0.
  // B(seat1): As Ad  C(seat2): 7h 2c  A(seat0): Ks Kd
  // board: burn, Ah 7s 3d (flop), burn 9c (turn), burn 4s (river)
  const d = deck(
    'As', '7h', 'Ks',
    'Ad', '2c', 'Kd',
    'Xx', 'Ah', '7s', '3d',
    'Yy', '9c',
    'Zz', '4s',
  );
  const hand = startHand(players, SETTINGS, 0, d);
  // Preflop. A is seat0 (UTG), B seat1 SB, C seat2 BB.
  // A shoves all-in for 100.
  assert.equal(hand.activeSeat, 0);
  let r = applyAction(hand, 'A', 'allin');
  assert.equal(r.ok, true);
  assert.equal(hand.seats[0].isAllIn, true);
  assert.equal(hand.currentBet, 100);
  // B calls 100.
  assert.equal(applyAction(hand, 'B', 'call').ok, true);
  // C calls 100.
  assert.equal(applyAction(hand, 'C', 'call').ok, true);
  assert.ok(isBettingRoundComplete(hand));

  // Now B vs C continue betting; advance flop. Only B and C can act.
  advanceStreet(hand); // flop
  // B bets 200, C folds.
  assert.equal(hand.activeSeat, 1);
  assert.equal(applyAction(hand, 'B', 'raise', 200).ok, true);
  assert.equal(applyAction(hand, 'C', 'fold').ok, true);
  assert.ok(isBettingRoundComplete(hand));

  // Run remaining streets to showdown (A all-in, B alone now but showdown needed).
  advanceStreet(hand); // turn — no actable since only B remains live & not all-in
  advanceStreet(hand); // river
  advanceStreet(hand); // showdown

  const { payouts } = settle(hand, {
    A: { name: 'A' }, B: { name: 'B' }, C: { name: 'C' },
  });
  // Main pot eligible {A,B,C}: 100*3 = 300. Best hand among A(KK+Ah=2pair? no,
  // KK pair), B(AA + Ah = trips aces). B wins main pot.
  // Side pot: B and C each added 100 more (to 200). C folded -> dead money.
  // Side pot amount = (200-100)*2 = 200, eligible {B} (C folded). B wins it.
  // B wins everything: 300 + 200 = 500.
  assert.equal(payouts['B'], 500);
  assert.equal(payouts['A'], undefined);
});

test('under-full all-in does not reopen betting', () => {
  const players = [
    { id: 'A', seat: 0, chips: 1000 },
    { id: 'B', seat: 1, chips: 1000 },
    { id: 'C', seat: 2, chips: 28 }, // tiny stack
  ];
  const hand = startHand(players, SETTINGS, 0, makeDeck());
  // A raises to 20. B (SB) re-raises to 40 (full raise size 20).
  assert.equal(applyAction(hand, 'A', 'raise', 20).ok, true);
  assert.equal(applyAction(hand, 'B', 'raise', 40).ok, true);
  // C had BB 10, has 18 left -> shoves all-in for 28 total. 28 < 40+? raise size
  // would be 28-40 negative; actually C total = 28 which is < currentBet 40, so
  // this is an all-in call for less. C is all-in.
  const rc = applyAction(hand, 'C', 'allin');
  assert.equal(rc.ok, true);
  assert.equal(hand.seats[2].isAllIn, true);
  // currentBet stays 40 (C's shove was below a call).
  assert.equal(hand.currentBet, 40);
  // Action returns to A, who already acted; A can call/raise/fold.
  assert.equal(hand.activeSeat, 0);
});

// Helper deck: 6 hole cards + plenty of board/burn filler.
function makeDeck() {
  return deck(
    'As', 'Ks', 'Qs', // round 1
    'Ad', 'Kd', 'Qd', // round 2
    'Xx', '2h', '3h', '4h', // burn + flop
    'Yy', '5h', // burn + turn
    'Zz', '6h', // burn + river
  );
}
