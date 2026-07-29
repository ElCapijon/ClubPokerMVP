// ============================================================
// botPlayer.js - Simple bot AI for testing
//
// Bots make quick decisions based on their hole cards,
// community cards, pot odds, and current bet.
// ============================================================

const { evaluateHand } = require('./HandEvaluator');

const BOT_NAMES = [
  '🤖 Bot Alice',
  '🤖 Bot Bob', 
  '🤖 Bot Charlie',
  '🤖 Bot Diana',
  '🤖 Bot Evan',
];

let botNameIndex = 0;

/**
 * Get the next bot name (rotates through the pool)
 */
function getNextBotName() {
  const name = BOT_NAMES[botNameIndex % BOT_NAMES.length];
  botNameIndex++;
  return name;
}

/**
 * Reset bot name index (e.g., when removing all bots)
 */
function resetBotNames() {
  botNameIndex = 0;
}

/**
 * Get a rough hand strength rating (0-1) from hole cards + community cards.
 * Simple heuristic: pair or better = strong, high cards = medium, low cards = weak.
 */
function getHandStrength(holeCards, communityCards) {
  // If we have community cards, use the hand evaluator
  if (communityCards && communityCards.length >= 3) {
    try {
      const result = evaluateHand(holeCards, communityCards);
      if (result && result.rank) {
        // Normalize rank (1 = high card, 9 = royal flush) to 0-1
        return Math.min(1, result.rank / 9);
      }
    } catch (e) {
      // Fall through to simple heuristic
    }
  }

  // Simple pre-flop heuristic based on hole cards
  const ranks = holeCards.map(c => c.rank);
  const suited = holeCards[0].suit === holeCards[1].suit;

  // Pocket pair
  if (ranks[0] === ranks[1]) {
    if (ranks[0] >= 10) return 0.85; // High pair
    if (ranks[0] >= 7) return 0.65;  // Medium pair
    return 0.5;                       // Low pair
  }

  // High cards
  const highCard = Math.max(...ranks);
  const lowCard = Math.min(...ranks);
  const gap = highCard - lowCard;

  if (highCard >= 12 && suited) return 0.75;      // AKs, AQs
  if (highCard >= 12) return 0.65;                // AK, AQ
  if (highCard >= 10 && lowCard >= 10) return 0.6; // Two broadway
  if (highCard >= 10 && suited) return 0.5;        // Suited connector-ish
  if (highCard >= 10) return 0.4;                  // One broadway
  if (suited && gap <= 2) return 0.35;             // Suited connector
  return 0.25;                                      // Garbage
}

/**
 * Decide a bot's action based on game state.
 * 
 * @param {Object} hand - The current hand state
 * @param {number} seatIndex - The bot's seat index
 * @returns {Object} { action: 'fold'|'check'|'call'|'raise', amount?: number }
 */
function decideAction(hand, seatIndex) {
  const player = hand.players.find(p => p.seatIndex === seatIndex);
  if (!player) return { action: 'fold' };

  const { holeCards, stack, roundBet } = player;
  const { communityCards, currentBet, pot, bigBlind } = hand;

  // Get hand strength
  const strength = getHandStrength(holeCards, communityCards);

  // Random factor to add variety
  const bluff = Math.random() * 0.2 - 0.1; // -0.1 to +0.1
  const adjustedStrength = Math.max(0, Math.min(1, strength + bluff));

  const callAmount = currentBet - roundBet;

  // If there's no bet to call
  if (currentBet === 0 || callAmount <= 0) {
    if (adjustedStrength > 0.7) {
      // Strong hand: bet 1/2 to 3/4 pot
      const betSize = Math.min(
        Math.floor(pot * (0.4 + Math.random() * 0.3)),
        stack
      );
      return { action: 'bet', amount: Math.max(betSize, bigBlind) };
    }
    // Weak-ish hand: check
    return { action: 'check' };
  }

  // There's a bet to call
  const potOdds = callAmount / (pot + callAmount);

  // Decide whether to call based on hand strength vs pot odds
  if (adjustedStrength > potOdds + 0.1 || adjustedStrength > 0.6) {
    // Strong enough or good odds: call
    // Sometimes raise if very strong
    if (adjustedStrength > 0.85 && Math.random() < 0.4 && stack > callAmount * 2) {
      const raiseAmount = Math.min(
        Math.floor(pot * (0.5 + Math.random() * 0.5)) + currentBet,
        stack + roundBet
      );
      return { action: 'raise', amount: raiseAmount };
    }
    return { action: 'call' };
  }

  // Weak hand + bad odds: fold sometimes
  if (adjustedStrength < 0.2 || (adjustedStrength < 0.35 && potOdds > 0.3)) {
    return { action: 'fold' };
  }

  // Borderline: call small bets, fold big ones
  if (callAmount <= bigBlind * 2 && Math.random() < 0.5) {
    return { action: 'call' };
  }

  return { action: 'fold' };
}

module.exports = {
  getNextBotName,
  resetBotNames,
  decideAction,
  getHandStrength,
};
