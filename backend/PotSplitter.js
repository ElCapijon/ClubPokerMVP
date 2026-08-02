// ============================================================
// PotSplitter.js - Side pot calculation and winner determination
// ============================================================

const { evaluateHand, compareHands, rankHands } = require('./HandEvaluator');

/**
 * Calculate side pots from each player's total contribution (betAmount).
 * Works for all-in side pots AND folded players (their chips are already in
 * the pot, so they must be counted even though they can't win).
 * 
 * Each player: { playerIndex, stack, betAmount, isAllIn }
 * 
 * The algorithm:
 * 1. Sort players by total committed (betAmount), ascending.
 * 2. For each unique bet amount threshold, create a side pot.
 * 3. Each side pot consists of contributions from all players who
 *    bet at least that threshold, up to the threshold amount.
 * 
 * Returns: [{ potAmount, eligiblePlayerIndices }]
 */
function calculateSidePots(players) {
  // Sort by bet amount ascending
  const sorted = [...players].sort((a, b) => a.betAmount - b.betAmount);
  
  const pots = [];
  let previousBet = 0;
  let remainingPlayers = sorted.length;

  for (let i = 0; i < sorted.length; i++) {
    const currentBet = sorted[i].betAmount;

    if (currentBet > previousBet) {
      // Each remaining player contributes (currentBet - previousBet)
      const contributionPerPlayer = currentBet - previousBet;
      const potAmount = contributionPerPlayer * remainingPlayers;

      // Eligible players are those who bet >= currentBet
      const eligibleIndices = sorted
        .slice(i)
        .map(p => p.playerIndex);

      pots.push({
        potAmount,
        eligiblePlayerIndices: eligibleIndices,
        level: currentBet,
      });

      previousBet = currentBet;
    }

    // Player is fully resolved, reduce remaining count
    remainingPlayers--;
  }

  return pots;
}

/**
 * Determine winners for the main pot and all side pots.
 * 
 * @param {Array} players - Array of { playerIndex, holeCards, stack, betAmount, isAllIn, isFolded }
 * @param {Array} communityCards - The 5 community cards
 * 
 * Returns: [{ potIndex, potAmount, winners: [{ playerIndex, handResult, amountWon }] }]
 */
function determineWinners(players, communityCards) {
  // Folded players cannot win, but their chips are already in the pot — they
  // must still be counted so no money disappears when someone folds mid-hand
  // (e.g. calls a bet, then folds to a later raise, while others go to showdown).
  const activePlayers = players.filter(p => !p.isFolded);

  if (activePlayers.length === 0) {
    return [];
  }

  // Calculate pots from EVERY player's contribution. Folded players' betAmounts
  // keep the pot totals correct; eligibility is enforced below by intersecting
  // each pot's eligiblePlayerIndices with the ranked ACTIVE players, so a
  // folded player can never win.
  const pots = calculateSidePots(players.map(p => ({
    playerIndex: p.playerIndex,
    stack: p.stack,
    betAmount: p.betAmount,
    isAllIn: p.isAllIn || false,
  })));

  // If no one bet anything at all (everyone checked), create a single main pot.
  if (pots.length === 0) {
    const totalPot = players.reduce((sum, p) => sum + p.betAmount, 0);
    pots.push({
      potAmount: totalPot,
      eligiblePlayerIndices: activePlayers.map(p => p.playerIndex),
      level: 0,
    });
  }

  // Evaluate each active player's best hand
  const playerHands = activePlayers.map(p => ({
    playerIndex: p.playerIndex,
    handResult: evaluateHand(p.holeCards, communityCards),
  }));

  // Rank the hands
  const ranked = rankHands(playerHands);

  // Award each pot to the best-ranked eligible player(s)
  const results = pots.map((pot, potIndex) => {
    const eligible = ranked.filter(r => pot.eligiblePlayerIndices.includes(r.playerIndex));
    
    if (eligible.length === 0) {
      // Every contributor to this pot level is folded (a player folded after
      // betting more than anyone else matched — their unmatched chips can't be
      // won by anyone, but they also can't vanish). Folded players forfeit
      // their chips, so award the orphaned pot to the best active hand(s).
      const top = ranked.filter(r => r.rankPosition === ranked[0].rankPosition);
      const share = Math.floor(pot.potAmount / top.length);
      const remainder = pot.potAmount % top.length;
      return {
        potIndex,
        potAmount: pot.potAmount,
        level: pot.level,
        winners: top.map((w, i) => ({
          playerIndex: w.playerIndex,
          handResult: w.handResult,
          amountWon: share + (i < remainder ? 1 : 0),
        })),
      };
    }

    const bestRank = eligible[0].rankPosition;
    const winners = eligible.filter(r => r.rankPosition === bestRank);

    // Split the pot among winners (remainder distributed 1 chip at a time)
    const share = Math.floor(pot.potAmount / winners.length);
    const remainder = pot.potAmount % winners.length;

    return {
      potIndex,
      potAmount: pot.potAmount,
      level: pot.level,
      winners: winners.map((w, i) => ({
        playerIndex: w.playerIndex,
        handResult: w.handResult,
        amountWon: share + (i < remainder ? 1 : 0),
      })),
    };
  });

  return results;
}

/**
 * Simple winner determination when no side pots needed
 * (all players have bet the same amount).
 */
function determineMainWinner(playersHands) {
  const ranked = rankHands(playersHands);
  const bestRank = ranked[0].rankPosition;
  return ranked.filter(r => r.rankPosition === bestRank);
}

module.exports = {
  calculateSidePots,
  determineWinners,
  determineMainWinner,
};
