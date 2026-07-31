// ============================================================
// BotPlayer.js - Simple bot AI for filling empty seats
//
// Bots make decisions based on hand strength and pot odds.
// They are identified by userId prefix 'bot_' and are easily
// removed by clearing those seats.
//
// To remove bots: emit 'remove_bots' with { gameId }
// To add bots:    emit 'add_bots' with { gameId }
// ============================================================

const { evaluateHand } = require('./HandEvaluator');

// Unique bot names (no duplicates within a game)
const BOT_NAMES = ['🤖 Alice', '🤖 Bob', '🤖 Charlie', '🤖 Diana', '🤖 Evan', '🤖 Fiona'];

// Global counter for unique bot IDs
let botCounter = 0;

/**
 * Generate a unique bot user ID.
 */
function generateBotId() {
  botCounter++;
  return `bot_${Date.now()}_${botCounter}`;
}

/**
 * Reset the bot counter (useful for testing).
 */
function resetBotCounter() {
  botCounter = 0;
}

/**
 * Get a display name for a bot. Returns names from the pool
 * that haven't been used yet at the given game.
 */
function getBotName(usedNames) {
  const available = BOT_NAMES.filter(n => !usedNames.includes(n));
  if (available.length === 0) {
    // Fallback: use a numbered name
    return `Bot #${botCounter}`;
  }
  return available[0];
}

/**
 * Evaluate a bot's hand strength as a normalized 0-1 value.
 * - Pre-flop: uses a quick heuristic (pocket pairs, high cards, suitedness)
 * - Post-flop: uses the actual evaluateHand function
 */
function evaluateHandStrength(holeCards, communityCards, pot, currentBet, playerStack) {
  if (!holeCards || holeCards.length < 2) return 0;

  if (!communityCards || communityCards.length === 0) {
    // Pre-flop heuristic
    return evaluatePreFlopStrength(holeCards);
  }

  // Post-flop: use actual hand evaluation
  const result = evaluateHand(holeCards, communityCards);
  if (!result) return 0;

  // Normalize rank (1-9) to 0-1 with some scaling
  const rankScore = result.rank / 9;
  // Bonus for strong kickers
  const kickerBonus = result.kickers && result.kickers.length > 0
    ? (result.kickers[0] - 2) / 12 * 0.1
    : 0;
  return Math.min(1, rankScore + kickerBonus);
}

/**
 * Quick pre-flop hand strength heuristic (0-1).
 */
function evaluatePreFlopStrength(holeCards) {
  const c1 = holeCards[0].value;
  const c2 = holeCards[1].value;
  const suited = holeCards[0].suit === holeCards[1].suit;
  const paired = c1 === c2;
  const highCard = Math.max(c1, c2);
  const lowCard = Math.min(c1, c2);
  const gap = Math.abs(c1 - c2);

  let score = 0;

  // Pocket pairs are strong
  if (paired) {
    score = 0.5 + (c1 - 2) / 12 * 0.4;
    return Math.min(1, score);
  }

  // High cards
  score += (highCard - 2) / 12 * 0.4;
  score += (lowCard - 2) / 12 * 0.1;

  // Suited bonus
  if (suited) score += 0.05;

  // Connected bonus (small gaps)
  if (gap <= 2) score += 0.05;
  if (gap === 1) score += 0.03;

  // Premium hands
  if (highCard >= 14 && lowCard >= 13) score += 0.1; // A-K
  if (highCard >= 14 && lowCard >= 12) score += 0.05; // A-Q

  return Math.min(1, score);
}

/**
 * Decide what action a bot should take.
 * Returns { action, amount } where amount is optional.
 *
 * @param {Object} hand - The current hand state
 * @param {number} seatIndex - The bot's seat index
 * @param {Object} game - The ring game state
 */
function decideAction(hand, seatIndex, game) {
  const player = hand.players.find(p => p.seatIndex === seatIndex);
  if (!player) return { action: 'fold' };

  const strength = evaluateHandStrength(
    player.holeCards,
    hand.communityCards,
    hand.pot,
    hand.currentBet,
    player.stack
  );

  const currentBet = hand.currentBet;
  const playerBet = player.roundBet;
  const toCall = currentBet - playerBet;
  const potSize = hand.pot;
  const randomFactor = (Math.random() - 0.5) * 0.15; // ±0.075 randomness

  const adjustedStrength = Math.max(0, Math.min(1, strength + randomFactor));

  // ── No bet to call: check or bet ──
  if (toCall <= 0) {
    if (adjustedStrength < 0.25) {
      return { action: 'check' };
    }
    // Bet ½-¾ pot with strong hands
    const betSize = Math.min(
      Math.floor(potSize * (0.4 + adjustedStrength * 0.35)),
      player.stack
    );
    if (betSize > 0 && adjustedStrength > 0.4) {
      return { action: 'bet', amount: betSize };
    }
    return { action: 'check' };
  }

  // ── There's a bet to call ──
  const potOdds = toCall / (potSize + toCall);

  // Very strong: raise
  if (adjustedStrength > 0.8 && player.stack >= toCall * 2) {
    const raiseAmount = Math.min(
      currentBet + Math.floor(potSize * 0.5),
      player.stack + playerBet
    );
    if (raiseAmount > currentBet) {
      return { action: 'raise', amount: raiseAmount };
    }
    // If can't raise, just call
    return { action: 'call' };
  }

  // Strong: call
  if (adjustedStrength > 0.5) {
    return { action: 'call' };
  }

  // Decent: call small bets, fold big ones
  if (adjustedStrength > 0.3) {
    if (potOdds < 0.3) {
      return { action: 'call' };
    }
    // Randomly call small bets
    if (toCall < potSize * 0.25 && Math.random() > 0.3) {
      return { action: 'call' };
    }
    return { action: 'fold' };
  }

  // Weak: fold
  return { action: 'fold' };
}

module.exports = {
  generateBotId,
  resetBotCounter,
  getBotName,
  evaluateHandStrength,
  evaluatePreFlopStrength,
  decideAction,
  BOT_NAMES,
};