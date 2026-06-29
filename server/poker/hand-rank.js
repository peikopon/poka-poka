// hand-rank.js — best 5-card hand evaluation from 5..7 cards.
//
// Cards are 2-char strings: rank + suit (see server/protocol.js).
//   ranks: '23456789TJQKA'  suits: 'shdc'

const RANK_ORDER = '23456789TJQKA';

// Hand class constants (higher = better).
export const HAND_RANK = Object.freeze({
  HIGH_CARD: 0,
  PAIR: 1,
  TWO_PAIR: 2,
  TRIPS: 3,
  STRAIGHT: 4,
  FLUSH: 5,
  FULL_HOUSE: 6,
  QUADS: 7,
  STRAIGHT_FLUSH: 8,
});

const HAND_NAME = Object.freeze({
  0: 'High Card',
  1: 'Pair',
  2: 'Two Pair',
  3: 'Three of a Kind',
  4: 'Straight',
  5: 'Flush',
  6: 'Full House',
  7: 'Four of a Kind',
  8: 'Straight Flush',
});

/** rank char -> numeric value (2..14, ace high). */
function rankValue(card) {
  return RANK_ORDER.indexOf(card[0]) + 2;
}

/**
 * Find the best straight among a set of rank values.
 * Returns the high-card value of the best straight, or 0 if none.
 * Handles the wheel (A-2-3-4-5 -> high card 5).
 * @param {Set<number>} valueSet distinct rank values present
 */
function straightHigh(valueSet) {
  // Ace can play low (value 1) for the wheel.
  const present = new Set(valueSet);
  if (present.has(14)) present.add(1);
  for (let high = 14; high >= 5; high--) {
    let ok = true;
    for (let v = high; v > high - 5; v--) {
      if (!present.has(v)) {
        ok = false;
        break;
      }
    }
    if (ok) return high;
  }
  return 0;
}

/**
 * From a list of cards forming a straight ending at `high`, pick the 5 cards.
 * @param {string[]} cards
 * @param {number} high straight high value (5..14)
 */
function pickStraightCards(cards, high, suitFilter) {
  const needed = [];
  for (let v = high; v > high - 5; v--) needed.push(v === 1 ? 14 : v);
  const picked = [];
  for (const want of needed) {
    const c = cards.find(
      (card) =>
        rankValue(card) === want &&
        (!suitFilter || card[1] === suitFilter) &&
        !picked.includes(card),
    );
    if (c) picked.push(c);
  }
  return picked;
}

/**
 * Evaluate the best 5-card poker hand from 5..7 cards.
 * @param {string[]} cards
 * @returns {{rank:number, name:string, score:number[], best5:string[]}}
 */
export function evaluate7(cards) {
  if (!Array.isArray(cards) || cards.length < 5 || cards.length > 7) {
    throw new Error(`evaluate7 expects 5..7 cards, got ${cards && cards.length}`);
  }

  // Group by suit and by rank.
  const bySuit = { s: [], h: [], d: [], c: [] };
  const countByValue = new Map(); // value -> count
  for (const card of cards) {
    bySuit[card[1]].push(card);
    const v = rankValue(card);
    countByValue.set(v, (countByValue.get(v) || 0) + 1);
  }

  // --- Straight flush ---
  let bestSF = null;
  for (const suit of Object.keys(bySuit)) {
    const suited = bySuit[suit];
    if (suited.length >= 5) {
      const vals = new Set(suited.map(rankValue));
      const high = straightHigh(vals);
      if (high && (!bestSF || high > bestSF.high)) {
        bestSF = { high, suit };
      }
    }
  }
  if (bestSF) {
    const best5 = pickStraightCards(cards, bestSF.high, bestSF.suit);
    return result(HAND_RANK.STRAIGHT_FLUSH, [bestSF.high], best5);
  }

  // Sort distinct values descending, with multiplicity info.
  // groups: array of { value, count } sorted by count desc then value desc.
  const groups = [...countByValue.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || b.value - a.value);

  // --- Quads ---
  if (groups[0].count === 4) {
    const quadVal = groups[0].value;
    const kicker = groups.filter((g) => g.value !== quadVal).map((g) => g.value).sort((a, b) => b - a)[0];
    const best5 = [
      ...cards.filter((c) => rankValue(c) === quadVal),
      cards.find((c) => rankValue(c) === kicker),
    ];
    return result(HAND_RANK.QUADS, [quadVal, kicker], best5);
  }

  // --- Full house (trips + pair, or two trips) ---
  const trips = groups.filter((g) => g.count === 3).map((g) => g.value).sort((a, b) => b - a);
  const pairs = groups.filter((g) => g.count === 2).map((g) => g.value).sort((a, b) => b - a);
  if (trips.length >= 1 && (pairs.length >= 1 || trips.length >= 2)) {
    const tripVal = trips[0];
    const pairVal = trips.length >= 2 ? Math.max(pairs[0] ?? 0, trips[1]) : pairs[0];
    const best5 = [
      ...cards.filter((c) => rankValue(c) === tripVal),
      ...cards.filter((c) => rankValue(c) === pairVal).slice(0, 2),
    ];
    return result(HAND_RANK.FULL_HOUSE, [tripVal, pairVal], best5);
  }

  // --- Flush ---
  for (const suit of Object.keys(bySuit)) {
    const suited = bySuit[suit];
    if (suited.length >= 5) {
      const top = suited
        .slice()
        .sort((a, b) => rankValue(b) - rankValue(a))
        .slice(0, 5);
      return result(HAND_RANK.FLUSH, top.map(rankValue), top);
    }
  }

  // --- Straight ---
  const allValues = new Set([...countByValue.keys()]);
  const sHigh = straightHigh(allValues);
  if (sHigh) {
    const best5 = pickStraightCards(cards, sHigh, null);
    return result(HAND_RANK.STRAIGHT, [sHigh], best5);
  }

  // --- Trips ---
  if (trips.length >= 1) {
    const tripVal = trips[0];
    const kickers = groups
      .filter((g) => g.value !== tripVal)
      .map((g) => g.value)
      .sort((a, b) => b - a)
      .slice(0, 2);
    const best5 = [
      ...cards.filter((c) => rankValue(c) === tripVal),
      ...kickers.map((k) => cards.find((c) => rankValue(c) === k)),
    ];
    return result(HAND_RANK.TRIPS, [tripVal, ...kickers], best5);
  }

  // --- Two pair ---
  if (pairs.length >= 2) {
    const [hi, lo] = pairs.slice(0, 2);
    const kicker = groups
      .filter((g) => g.value !== hi && g.value !== lo)
      .map((g) => g.value)
      .sort((a, b) => b - a)[0];
    const best5 = [
      ...cards.filter((c) => rankValue(c) === hi),
      ...cards.filter((c) => rankValue(c) === lo),
      cards.find((c) => rankValue(c) === kicker),
    ];
    return result(HAND_RANK.TWO_PAIR, [hi, lo, kicker], best5);
  }

  // --- One pair ---
  if (pairs.length === 1) {
    const pairVal = pairs[0];
    const kickers = groups
      .filter((g) => g.value !== pairVal)
      .map((g) => g.value)
      .sort((a, b) => b - a)
      .slice(0, 3);
    const best5 = [
      ...cards.filter((c) => rankValue(c) === pairVal),
      ...kickers.map((k) => cards.find((c) => rankValue(c) === k)),
    ];
    return result(HAND_RANK.PAIR, [pairVal, ...kickers], best5);
  }

  // --- High card ---
  const top = cards
    .slice()
    .sort((a, b) => rankValue(b) - rankValue(a))
    .slice(0, 5);
  return result(HAND_RANK.HIGH_CARD, top.map(rankValue), top);
}

function result(rank, tiebreakers, best5) {
  return {
    rank,
    name: HAND_NAME[rank],
    score: [rank, ...tiebreakers],
    best5,
  };
}

/**
 * Compare two evaluate7 results by their score tuples.
 * @returns {-1|0|1} 1 if a beats b, -1 if b beats a, 0 if tie.
 */
export function compareHands(a, b) {
  const sa = a.score;
  const sb = b.score;
  const n = Math.max(sa.length, sb.length);
  for (let i = 0; i < n; i++) {
    const x = sa[i] ?? 0;
    const y = sb[i] ?? 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}
