import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate7, compareHands } from './hand-rank.js';

test('high card', () => {
  const ev = evaluate7(['As', 'Kd', '9c', '7h', '4s']);
  assert.equal(ev.rank, 0);
  assert.equal(ev.name, 'High Card');
  assert.deepEqual(ev.score, [0, 14, 13, 9, 7, 4]);
});

test('one pair with kickers', () => {
  const ev = evaluate7(['As', 'Ad', 'Kc', 'Qh', '4s', '3d']);
  assert.equal(ev.rank, 1);
  assert.deepEqual(ev.score, [1, 14, 13, 12, 4]);
});

test('two pair beats pair, kicker decides', () => {
  const a = evaluate7(['As', 'Ad', 'Kc', 'Kh', 'Qs']);
  const b = evaluate7(['As', 'Ad', 'Kc', 'Kh', 'Js']);
  assert.equal(a.rank, 2);
  assert.equal(a.name, 'Two Pair');
  assert.equal(compareHands(a, b), 1);
});

test('three of a kind', () => {
  const ev = evaluate7(['7s', '7d', '7c', 'Kh', '2s']);
  assert.equal(ev.rank, 3);
  assert.deepEqual(ev.score, [3, 7, 13, 2]);
});

test('straight, ace-high', () => {
  const ev = evaluate7(['Ts', 'Jd', 'Qc', 'Kh', 'As', '2d']);
  assert.equal(ev.rank, 4);
  assert.deepEqual(ev.score, [4, 14]);
});

test('wheel straight A-2-3-4-5 has high card 5', () => {
  const ev = evaluate7(['As', '2d', '3c', '4h', '5s', 'Kd']);
  assert.equal(ev.rank, 4);
  assert.equal(ev.name, 'Straight');
  assert.deepEqual(ev.score, [4, 5]);
});

test('flush', () => {
  const ev = evaluate7(['As', 'Ks', '9s', '7s', '2s', '3d']);
  assert.equal(ev.rank, 5);
  assert.deepEqual(ev.score, [5, 14, 13, 9, 7, 2]);
});

test('flush beats straight', () => {
  const flush = evaluate7(['2s', '5s', '8s', 'Js', 'Ks']);
  const straight = evaluate7(['9c', 'Td', 'Jh', 'Qs', 'Kc']);
  assert.equal(flush.rank, 5);
  assert.equal(straight.rank, 4);
  assert.equal(compareHands(flush, straight), 1);
});

test('full house vs trips', () => {
  const fh = evaluate7(['Ks', 'Kd', 'Kc', '2h', '2s']);
  const trips = evaluate7(['Ks', 'Kd', 'Kc', '9h', '2s']);
  assert.equal(fh.rank, 6);
  assert.equal(fh.name, 'Full House');
  assert.equal(trips.rank, 3);
  assert.equal(compareHands(fh, trips), 1);
});

test('full house picks best trips + best pair from 7', () => {
  const ev = evaluate7(['Ks', 'Kd', 'Kc', 'Qh', 'Qs', '9h', '9d']);
  assert.equal(ev.rank, 6);
  assert.deepEqual(ev.score, [6, 13, 12]);
});

test('four of a kind', () => {
  const ev = evaluate7(['9s', '9d', '9c', '9h', 'As', '2d']);
  assert.equal(ev.rank, 7);
  assert.deepEqual(ev.score, [7, 9, 14]);
});

test('straight flush', () => {
  const ev = evaluate7(['5s', '6s', '7s', '8s', '9s', '2d']);
  assert.equal(ev.rank, 8);
  assert.deepEqual(ev.score, [8, 9]);
});

test('wheel straight flush (steel wheel) high card 5', () => {
  const ev = evaluate7(['As', '2s', '3s', '4s', '5s']);
  assert.equal(ev.rank, 8);
  assert.deepEqual(ev.score, [8, 5]);
});

test('exact tie returns 0', () => {
  const a = evaluate7(['As', 'Ks', 'Qd', 'Jc', '9h']);
  const b = evaluate7(['Ad', 'Kd', 'Qs', 'Jh', '9c']);
  assert.equal(compareHands(a, b), 0);
});

test('best5 has exactly 5 cards', () => {
  const ev = evaluate7(['As', 'Ad', 'Kc', 'Qh', '4s', '3d', '2c']);
  assert.equal(ev.best5.length, 5);
});

test('straight flush beats four of a kind', () => {
  const sf = evaluate7(['5s', '6s', '7s', '8s', '9s']);
  const quads = evaluate7(['As', 'Ad', 'Ac', 'Ah', 'Ks']);
  assert.equal(compareHands(sf, quads), 1);
});
