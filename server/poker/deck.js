// deck.js — card deck construction and shuffling.
//
// Cards are 2-char strings: rank + suit (see server/protocol.js).
//   ranks: '23456789TJQKA'  suits: 'shdc'

const RANKS = '23456789TJQKA';
const SUITS = 'shdc';

/** @returns {string[]} a fresh ordered 52-card deck of unique cards. */
export function freshDeck() {
  const deck = [];
  for (const r of RANKS) {
    for (const s of SUITS) {
      deck.push(r + s);
    }
  }
  return deck;
}

/**
 * Fisher–Yates shuffle. Returns a NEW array; does not mutate the input.
 * @param {string[]} deck
 * @param {() => number} [rng] random source in [0,1)
 * @returns {string[]}
 */
export function shuffle(deck, rng = Math.random) {
  const out = deck.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}
