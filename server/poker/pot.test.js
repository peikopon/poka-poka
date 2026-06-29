import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSidePots } from './pot.js';

test('single pot — everyone contributed equally', () => {
  const pots = buildSidePots({ a: 100, b: 100, c: 100 }, []);
  assert.equal(pots.length, 1);
  assert.equal(pots[0].amount, 300);
  assert.deepEqual(new Set(pots[0].eligible), new Set(['a', 'b', 'c']));
});

test('one short all-in creates a side pot', () => {
  // a is all-in for 50, b and c put in 100 each.
  const pots = buildSidePots({ a: 50, b: 100, c: 100 }, []);
  assert.equal(pots.length, 2);
  // Main pot: 50 * 3 = 150, all three eligible.
  assert.equal(pots[0].amount, 150);
  assert.deepEqual(new Set(pots[0].eligible), new Set(['a', 'b', 'c']));
  // Side pot: 50 * 2 = 100, only b and c.
  assert.equal(pots[1].amount, 100);
  assert.deepEqual(new Set(pots[1].eligible), new Set(['b', 'c']));
});

test('multiple all-ins create three layers', () => {
  const pots = buildSidePots({ a: 25, b: 50, c: 100, d: 100 }, []);
  assert.equal(pots.length, 3);
  // layer 1: 25 * 4 = 100, eligible a,b,c,d
  assert.equal(pots[0].amount, 100);
  assert.deepEqual(new Set(pots[0].eligible), new Set(['a', 'b', 'c', 'd']));
  // layer 2: 25 * 3 = 75, eligible b,c,d
  assert.equal(pots[1].amount, 75);
  assert.deepEqual(new Set(pots[1].eligible), new Set(['b', 'c', 'd']));
  // layer 3: 50 * 2 = 100, eligible c,d
  assert.equal(pots[2].amount, 100);
  assert.deepEqual(new Set(pots[2].eligible), new Set(['c', 'd']));
});

test('folded contributor leaves dead money but cannot win', () => {
  // a folded after putting in 100, b & c contested to 100.
  const pots = buildSidePots({ a: 100, b: 100, c: 100 }, ['a']);
  assert.equal(pots.length, 1);
  assert.equal(pots[0].amount, 300);
  assert.deepEqual(new Set(pots[0].eligible), new Set(['b', 'c']));
});

test('folded short all-in dead money folds into live layer', () => {
  // a folded all-in for 30; b and c contest to 100.
  const pots = buildSidePots({ a: 30, b: 100, c: 100 }, ['a']);
  // Layer at 30 has eligible {b,c} (a folded); layer 30..100 also {b,c}.
  // They share the same eligible set, so they merge into one pot.
  assert.equal(pots.length, 1);
  assert.equal(pots[0].amount, 230);
  assert.deepEqual(new Set(pots[0].eligible), new Set(['b', 'c']));
});

test('Set accepted for foldedIds', () => {
  const pots = buildSidePots({ a: 100, b: 100 }, new Set(['a']));
  assert.deepEqual(new Set(pots[0].eligible), new Set(['b']));
});

test('empty contributions yields no pots', () => {
  assert.deepEqual(buildSidePots({}, []), []);
});
