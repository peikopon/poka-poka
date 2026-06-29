// pot.js — main + side pot construction.

/**
 * Build the layered main + side pots from per-player total contributions.
 *
 * @param {Record<string, number>} contribs  playerId -> total chips contributed THIS HAND.
 * @param {Iterable<string>|Set<string>} foldedIds  ids of players who folded.
 * @returns {{amount:number, eligible:string[]}[]}  pots in increasing all-in order.
 *
 * Folded players' chips remain in the pot (dead money) but those players are
 * never `eligible` to win. Each pot layer is the slice of chips between two
 * consecutive contribution thresholds, multiplied by the number of players who
 * reached that threshold; eligible = non-folded players who contributed at least
 * that threshold.
 */
export function buildSidePots(contribs, foldedIds) {
  const folded = foldedIds instanceof Set ? foldedIds : new Set(foldedIds || []);

  // Players who actually put chips in.
  const players = Object.keys(contribs).filter((id) => (contribs[id] || 0) > 0);
  if (players.length === 0) return [];

  // Distinct positive contribution levels, ascending.
  const levels = [...new Set(players.map((id) => contribs[id]))].sort((a, b) => a - b);

  const pots = [];
  let prev = 0;
  for (const level of levels) {
    const slice = level - prev;
    if (slice <= 0) {
      prev = level;
      continue;
    }
    // Everyone who contributed at least `level` pays `slice` into this layer.
    const contributors = players.filter((id) => contribs[id] >= level);
    const amount = slice * contributors.length;
    const eligible = contributors.filter((id) => !folded.has(id));
    if (amount > 0) {
      pots.push({ amount, eligible });
    }
    prev = level;
  }

  // Merge adjacent layers that share the same eligible set (keeps output tidy,
  // e.g. dead money from a folded short-stack folds into the next live layer).
  const merged = [];
  for (const pot of pots) {
    const last = merged[merged.length - 1];
    if (last && sameSet(last.eligible, pot.eligible)) {
      last.amount += pot.amount;
    } else {
      merged.push({ amount: pot.amount, eligible: pot.eligible.slice() });
    }
  }
  return merged;
}

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((x) => setB.has(x));
}
