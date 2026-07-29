// ============================================================
// HandEvaluator.js - Poker hand evaluation engine
// 
// Evaluates the best 5-card hand from 7 cards (2 hole + 5 board)
// by iterating over all 21 combinations of 5 cards from 7.
// ============================================================

// Hand rank constants (higher = better)
const HAND_RANKS = {
  HIGH_CARD: 1,
  ONE_PAIR: 2,
  TWO_PAIR: 3,
  THREE_OF_A_KIND: 4,
  STRAIGHT: 5,
  FLUSH: 6,
  FULL_HOUSE: 7,
  FOUR_OF_A_KIND: 8,
  STRAIGHT_FLUSH: 9,
};

const HAND_NAMES = {
  1: 'High Card',
  2: 'One Pair',
  3: 'Two Pair',
  4: 'Three of a Kind',
  5: 'Straight',
  6: 'Flush',
  7: 'Full House',
  8: 'Four of a Kind',
  9: 'Straight Flush',
};

/**
 * Generate all C(n, k) combinations from an array.
 */
function getCombinations(arr, k) {
  if (k === 0) return [[]];
  if (arr.length === 0) return [];

  const [first, ...rest] = arr;
  const withFirst = getCombinations(rest, k - 1).map(c => [first, ...c]);
  const withoutFirst = getCombinations(rest, k);

  return [...withFirst, ...withoutFirst];
}

/**
 * Count occurrences of each card value in the hand.
 * Returns a Map<value, count>
 */
function countValues(cards) {
  const counts = new Map();
  for (const card of cards) {
    counts.set(card.value, (counts.get(card.value) || 0) + 1);
  }
  return counts;
}

/**
 * Check if 5 cards form a flush (all same suit).
 */
function isFlush(cards) {
  if (cards.length !== 5) return false;
  const suit = cards[0].suit;
  return cards.every(c => c.suit === suit);
}

/**
 * Check if 5 cards form a straight (consecutive values).
 * Returns the highest card value if straight, or null.
 * Handles the A-2-3-4-5 (wheel) case.
 */
function getStraightHigh(cards) {
  if (cards.length !== 5) return null;

  const values = cards.map(c => c.value).sort((a, b) => b - a);

  // Normal straight: consecutive values
  if (values[0] - values[4] === 4 && new Set(values).size === 5) {
    return values[0];
  }

  // Wheel: A-2-3-4-5 (values: 14, 2, 3, 4, 5)
  if (values[0] === 14 && values[1] === 5 && values[2] === 4 && values[3] === 3 && values[4] === 2) {
    return 5; // 5-high straight
  }

  return null;
}

/**
 * Evaluate a single 5-card hand.
 * Returns { rank, rankName, kickers, handCards } or null if invalid.
 */
function evaluate5Cards(cards) {
  if (cards.length !== 5) return null;

  const values = cards.map(c => c.value).sort((a, b) => b - a);
  const valueCounts = countValues(cards);
  const counts = Array.from(valueCounts.entries())
    .sort((a, b) => {
      // Sort by count (desc), then by value (desc)
      if (b[1] !== a[1]) return b[1] - a[1];
      return b[0] - a[0];
    });

  const flush = isFlush(cards);
  const straightHigh = getStraightHigh(cards);

  // Check for straight flush
  if (flush && straightHigh !== null) {
    return {
      rank: HAND_RANKS.STRAIGHT_FLUSH,
      rankName: 'Straight Flush',
      kickers: [straightHigh],
      handCards: cards,
    };
  }

  // Check for four of a kind
  if (counts[0][1] === 4) {
    const quadValue = counts[0][0];
    const kicker = counts[1][0];
    return {
      rank: HAND_RANKS.FOUR_OF_A_KIND,
      rankName: 'Four of a Kind',
      kickers: [quadValue, kicker],
      handCards: cards,
    };
  }

  // Check for full house
  if (counts[0][1] === 3 && counts[1][1] === 2) {
    return {
      rank: HAND_RANKS.FULL_HOUSE,
      rankName: 'Full House',
      kickers: [counts[0][0], counts[1][0]],
      handCards: cards,
    };
  }

  // Check for flush
  if (flush) {
    return {
      rank: HAND_RANKS.FLUSH,
      rankName: 'Flush',
      kickers: values,
      handCards: cards,
    };
  }

  // Check for straight
  if (straightHigh !== null) {
    return {
      rank: HAND_RANKS.STRAIGHT,
      rankName: 'Straight',
      kickers: [straightHigh],
      handCards: cards,
    };
  }

  // Check for three of a kind
  if (counts[0][1] === 3) {
    const tripValue = counts[0][0];
    const kickers = counts.slice(1).map(c => c[0]).sort((a, b) => b - a);
    return {
      rank: HAND_RANKS.THREE_OF_A_KIND,
      rankName: 'Three of a Kind',
      kickers: [tripValue, ...kickers],
      handCards: cards,
    };
  }

  // Check for two pair
  if (counts[0][1] === 2 && counts[1][1] === 2) {
    const pairs = [counts[0][0], counts[1][0]].sort((a, b) => b - a);
    const kicker = counts[2][0];
    return {
      rank: HAND_RANKS.TWO_PAIR,
      rankName: 'Two Pair',
      kickers: [...pairs, kicker],
      handCards: cards,
    };
  }

  // Check for one pair
  if (counts[0][1] === 2) {
    const pairValue = counts[0][0];
    const kickers = counts.slice(1).map(c => c[0]).sort((a, b) => b - a);
    return {
      rank: HAND_RANKS.ONE_PAIR,
      rankName: 'One Pair',
      kickers: [pairValue, ...kickers],
      handCards: cards,
    };
  }

  // High card
  return {
    rank: HAND_RANKS.HIGH_CARD,
    rankName: 'High Card',
    kickers: values,
    handCards: cards,
  };
}

/**
 * Compare two kicker arrays lexicographically.
 * Returns:
 *   1 if a wins
 *  -1 if b wins
 *   0 if tie
 */
function compareKickers(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] > b[i]) return 1;
    if (a[i] < b[i]) return -1;
  }
  return 0;
}

/**
 * Evaluate the best 5-card hand from 7 cards (2 hole + 5 board).
 * Returns { rank, rankName, kickers, handCards } or null if fewer than 5 cards.
 */
function evaluateHand(handCards, communityCards) {
  const allCards = [...handCards, ...communityCards];

  if (allCards.length < 5) {
    return null;
  }

  // Generate all C(n, 5) combinations
  const combinations = getCombinations(allCards, 5);

  let best = null;

  for (const combo of combinations) {
    const result = evaluate5Cards(combo);
    if (!best || compareHands(result, best) > 0) {
      best = result;
    }
  }

  return best;
}

/**
 * Compare two hand evaluation results.
 * Returns:
 *   positive if handA is better
 *   negative if handB is better
 *   0 if tie
 */
function compareHands(handA, handB) {
  if (handA.rank !== handB.rank) {
    return handA.rank - handB.rank;
  }
  return compareKickers(handA.kickers, handB.kickers);
}

/**
 * Compare multiple hands and return sorted results (best first).
 * Input: array of { playerIndex, handResult }
 * Output: sorted array, best first, with rankPosition field
 */
function rankHands(playerHands) {
  const sorted = [...playerHands].sort((a, b) => compareHands(b.handResult, a.handResult));

  // Assign rank positions (handling ties)
  let currentRank = 1;
  let skipCount = 1;

  for (let i = 0; i < sorted.length; i++) {
    if (i === 0) {
      sorted[i].rankPosition = 1;
    } else {
      const cmp = compareHands(sorted[i].handResult, sorted[i - 1].handResult);
      if (cmp === 0) {
        sorted[i].rankPosition = sorted[i - 1].rankPosition;
        skipCount++;
      } else {
        currentRank += skipCount;
        sorted[i].rankPosition = currentRank;
        skipCount = 1;
      }
    }
  }

  return sorted;
}

module.exports = {
  HAND_RANKS,
  HAND_NAMES,
  evaluateHand,
  evaluate5Cards,
  compareHands,
  rankHands,
  getCombinations,
};
