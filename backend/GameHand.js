// ============================================================
// GameHand.js - Single hand lifecycle manager
//
// Manages: dealer rotation, blinds, turn order, street
// advancement (PREFLOP → FLOP → TURN → RIVER → SHOWDOWN)
// ============================================================

const { createDeck } = require('./Deck');
const { evaluateHand, compareHands, rankHands, HAND_NAMES } = require('./HandEvaluator');
const { determineWinners } = require('./PotSplitter');

// Game states
const GAME_STATES = {
  WAITING: 'WAITING',
  PREFLOP: 'PREFLOP',
  FLOP: 'FLOP',
  TURN: 'TURN',
  RIVER: 'RIVER',
  SHOWDOWN: 'SHOWDOWN',
  HAND_COMPLETE: 'HAND_COMPLETE',
};

/**
 * Create a new hand from a club's state.
 * 
 * @param {Object} clubState - The club state from in-memory store
 * @param {number} handCount - The hand number (for dealer rotation)
 * @returns {Object} The hand object
 */
function createHand(clubState, handCount) {
  const { seats, tableSettings } = clubState;

  // Collect active (seated & connected) players
  // Skip: null seats, disconnected players, players sitting out, players with 0 stack
  const players = [];
  for (let seatIndex = 0; seatIndex < seats.length; seatIndex++) {
    const seat = seats[seatIndex];
    if (seat && seat.isConnected && !seat.isSittingOut && seat.stack > 0) {
      players.push({
        seatIndex,
        userId: seat.userId,
        userName: seat.userName,
        holeCards: [],
        stack: seat.stack,
        betAmount: 0,         // total bet in this hand
        roundBet: 0,          // bet in current betting round
        postedBlind: 0,       // SB/BB amount posted (for blinds-paid tracking)
        sawFlop: false,       // set true when this player is dealt the flop
        isFolded: false,
        isAllIn: false,
        hasActed: false,      // acted in current betting round
        isConnected: true,
      });
    }
  }

  if (players.length < 2) {
    return null; // Need at least 2 players
  }

  // Determine dealer (rotate based on handCount)
  const dealerOffset = handCount % players.length;
  const dealerPlayerIndex = dealerOffset; // Which player entry (0-based) is dealer

  // Players are ordered by seat. We find the dealer by player index.
  // The SB is the next active player clockwise after dealer.
  // The BB is the next active player after SB.

  return {
    clubId: clubState.id,
    handId: `${clubState.id}:${handCount}`,
    gameStatus: GAME_STATES.PREFLOP,
    handCount,

    // Player list (only active players, ordered by seat index)
    players,
    dealerPlayerIndex,

    // Cards
    communityCards: [],

    // Pot tracking
    pot: 0,
    currentBet: 0,           // current highest bet for this round
    minRaise: tableSettings.bb,

    // Turn tracking
    currentPlayerIndex: -1,   // index into this.players[]
    lastRaiserIndex: -1,     // index into this.players[]

    // Settings
    smallBlind: tableSettings.sb,
    bigBlind: tableSettings.bb,
    startingStack: tableSettings.startingStack,
    actionTimer: tableSettings.timer,
    allowRebuys: tableSettings.allowRebuys,

    // Deck state (remaining cards)
    _deck: [],

    // Timer
    actionStartTime: Date.now(),
  };
}

/**
 * Start the hand: deal cards, post blinds, set first turn.
 */
function startHand(hand) {
  if (hand.players.length < 2) return hand;

  // Create and shuffle deck
  const deck = createDeck();
  hand._deck = shuffleDeck(deck);

  // Deal 2 hole cards to each player
  for (let i = 0; i < hand.players.length; i++) {
    hand.players[i].holeCards = [hand._deck.pop(), hand._deck.pop()];
  }

  // Determine blind positions
  const sbIndex = getNextActivePlayerIndex(hand, hand.dealerPlayerIndex);
  const bbIndex = getNextActivePlayerIndex(hand, sbIndex);

  hand.currentPlayerIndex = getNextActivePlayerIndex(hand, bbIndex);

  // Post blinds
  const sbPlayer = hand.players[sbIndex];
  const bbPlayer = hand.players[bbIndex];

  const sbAmount = Math.min(hand.smallBlind, sbPlayer.stack);
  const bbAmount = Math.min(hand.bigBlind, bbPlayer.stack);

  sbPlayer.stack -= sbAmount;
  sbPlayer.betAmount = sbAmount;
  sbPlayer.roundBet = sbAmount;
  sbPlayer.postedBlind = sbAmount;
  sbPlayer.hasActed = true;

  bbPlayer.stack -= bbAmount;
  bbPlayer.betAmount = bbAmount;
  bbPlayer.roundBet = bbAmount;
  bbPlayer.postedBlind = bbAmount;
  bbPlayer.hasActed = true; // BB has acted by posting the big blind

  hand.pot = sbAmount + bbAmount;
  hand.currentBet = bbAmount;
  hand.minRaise = hand.bigBlind;
  hand.lastRaiserIndex = bbIndex;

  hand.actionStartTime = Date.now();

  return hand;
}

/**
 * Get the index of the next active player clockwise, wrapping around.
 * Skips folded and all-in players.
 * 
 * @param {Object} hand - The hand object
 * @param {number} fromIndex - Starting player index
 * @returns {number} Next active player index, or -1 if none
 */
function getNextActivePlayerIndex(hand, fromIndex) {
  const count = hand.players.length;
  for (let i = 1; i <= count; i++) {
    const idx = (fromIndex + i) % count;
    const player = hand.players[idx];
    if (!player.isFolded && !player.isAllIn) {
      return idx;
    }
  }
  return -1;
}

/**
 * Check if the current betting round is complete.
 * A round is complete when:
 * - All non-folded, non-all-in players have acted AND
 * - Everyone has either matched the current bet or folded
 * - OR only one player remains (everyone else folded)
 */
function isRoundComplete(hand) {
  const activePlayers = hand.players.filter(p => !p.isFolded);
  
  // If only one player left, round is complete
  if (activePlayers.length <= 1) return true;

  const nonAllIn = activePlayers.filter(p => !p.isAllIn);

  // If all remaining players are all-in, round is complete
  if (nonAllIn.length === 0) return true;

  // Check if all non-all-in players have acted and matched the bet
  for (const player of nonAllIn) {
    if (!player.hasActed) return false;
    if (player.roundBet < hand.currentBet && !player.isAllIn) return false;
  }

  return true;
}

/**
 * Advance to the next street (PREFLOP → FLOP → TURN → RIVER → SHOWDOWN).
 * Returns the new hand state after advancement.
 */
function advanceStreet(hand) {
  // Reset round-specific state
  for (const player of hand.players) {
    player.roundBet = 0;
    player.hasActed = false;
  }
  hand.currentBet = 0;
  hand.lastRaiserIndex = -1;

  switch (hand.gameStatus) {
    case GAME_STATES.PREFLOP:
      // Burn and deal flop (3 cards)
      hand._deck.pop(); // burn
      hand.communityCards.push(hand._deck.pop(), hand._deck.pop(), hand._deck.pop());
      hand.gameStatus = GAME_STATES.FLOP;
      // Mark every player still in the hand as having seen the flop
      for (const p of hand.players) {
        if (!p.isFolded) p.sawFlop = true;
      }
      break;

    case GAME_STATES.FLOP:
      // Burn and deal turn (1 card)
      hand._deck.pop(); // burn
      hand.communityCards.push(hand._deck.pop());
      hand.gameStatus = GAME_STATES.TURN;
      break;

    case GAME_STATES.TURN:
      // Burn and deal river (1 card)
      hand._deck.pop(); // burn
      hand.communityCards.push(hand._deck.pop());
      hand.gameStatus = GAME_STATES.RIVER;
      break;

    case GAME_STATES.RIVER:
      hand.gameStatus = GAME_STATES.SHOWDOWN;
      break;

    default:
      return hand;
  }

  // Set current turn to first active player after dealer
  if (hand.gameStatus !== GAME_STATES.SHOWDOWN) {
    hand.currentPlayerIndex = getNextActivePlayerIndex(hand, hand.dealerPlayerIndex);
    hand.actionStartTime = Date.now();
    
    // If first player in order has already acted (all-in), find next
    if (hand.currentPlayerIndex >= 0) {
      const player = hand.players[hand.currentPlayerIndex];
      if (player.isAllIn) {
        hand.currentPlayerIndex = getNextActivePlayerIndex(hand, hand.currentPlayerIndex);
      }
    }
  }

  return hand;
}

/**
 * Evaluate hands and determine winners at showdown.
 * Returns the hand with result data attached.
 * Attaches winningRank and winningUserId for challenge tracking.
 */
function goToShowdown(hand) {
  hand.gameStatus = GAME_STATES.SHOWDOWN;

  const activePlayers = hand.players.filter(p => !p.isFolded);

  if (activePlayers.length <= 1) {
    // Everyone folded, last player wins
    const winner = activePlayers[0];
    
    // Award the pot to the winner's stack
    winner.stack += hand.pot;
    
    const results = [{
      potIndex: 0,
      potAmount: hand.pot,
      level: hand.pot,
      winners: [{
        playerIndex: winner.seatIndex,
        seatIndex: winner.seatIndex,
        handResult: { rank: 0, rankName: 'Uncontested', kickers: [] },
        amountWon: hand.pot,
      }],
    }];
    hand.handResult = results;
    hand.winningUserId = winner.userId;
    hand.winningRank = 0;
    hand.gameStatus = GAME_STATES.HAND_COMPLETE;
    return hand;
  }

  // Use PotSplitter to determine winners
  const potPlayers = hand.players.map((p, idx) => ({
    playerIndex: idx, // index into hand.players
    seatIndex: p.seatIndex,
    holeCards: p.holeCards,
    stack: p.stack,
    betAmount: p.betAmount,
    isAllIn: p.isAllIn,
    isFolded: p.isFolded,
  }));

  const results = determineWinners(potPlayers, hand.communityCards);
  
  // Map player indices back to hand player indices and seat indices
  const mappedResults = results.map(pot => ({
    ...pot,
    winners: pot.winners.map(w => {
      const handPlayer = hand.players[w.playerIndex] || potPlayers[w.playerIndex];
      return {
        ...w,
        playerIndex: handPlayer ? handPlayer.seatIndex : -1,
        seatIndex: handPlayer ? handPlayer.seatIndex : -1,
      };
    }),
  }));

  // Award winnings to each player's stack
  let highestRank = -1;
  let firstWinnerId = null;
  for (const pot of mappedResults) {
    for (const winner of pot.winners) {
      const hp = hand.players.find(p => p.seatIndex === winner.seatIndex);
      if (hp) {
        hp.stack += winner.amountWon;
      }
      // Track the highest ranked hand's owner for challenge tracking
      if (winner.handResult && winner.handResult.rank > highestRank) {
        highestRank = winner.handResult.rank;
        const hp = hand.players.find(p => p.seatIndex === winner.seatIndex);
        if (hp) firstWinnerId = hp.userId;
      }
    }
  }

  hand.handResult = mappedResults;
  hand.winningUserId = firstWinnerId;
  hand.winningRank = highestRank > 0 ? highestRank : 0;
  hand.gameStatus = GAME_STATES.HAND_COMPLETE;
  return hand;
}

/**
 * Check if the hand is complete (gameStatus === HAND_COMPLETE).
 */
function isHandComplete(hand) {
  return hand.gameStatus === GAME_STATES.HAND_COMPLETE;
}

/**
 * Get the public state of the hand (no hole cards).
 * Suitable for broadcasting to all players.
 */
function getPublicState(hand) {
  // Calculate remaining action time
  const elapsed = Date.now() - hand.actionStartTime;
  const totalMs = (hand.actionTimer || 20) * 1000;
  const remaining = Math.max(0, Math.ceil((totalMs - elapsed) / 1000));

  return {
    type: 'game_state_sync',
    handId: hand.handId,
    handCount: hand.handCount,
    gameStatus: hand.gameStatus,
    communityCards: hand.communityCards,
    pot: hand.pot,
    currentBet: hand.currentBet,
    minRaise: hand.minRaise,
    actionTimeRemaining: remaining,
    actionTimerTotal: hand.actionTimer || 20,
    dealerSeatIndex: hand.players[hand.dealerPlayerIndex]
      ? hand.players[hand.dealerPlayerIndex].seatIndex
      : -1,
    currentPlayerSeatIndex: hand.currentPlayerIndex >= 0
      ? hand.players[hand.currentPlayerIndex].seatIndex
      : -1,
    lastRaiserSeatIndex: hand.lastRaiserIndex >= 0
      ? hand.players[hand.lastRaiserIndex].seatIndex
      : -1,
    players: hand.players.map(p => ({
      seatIndex: p.seatIndex,
      userName: p.userName,
      stack: p.stack,
      betAmount: p.betAmount,
      isFolded: p.isFolded,
      isAllIn: p.isAllIn,
      hasActed: p.hasActed,
      isConnected: p.isConnected,
      isDealer: p.seatIndex === (hand.players[hand.dealerPlayerIndex]
        ? hand.players[hand.dealerPlayerIndex].seatIndex
        : -1),
    })),
  };
}

/**
 * Get the private state for a specific player (includes their hole cards).
 */
function getPrivateState(hand, seatIndex) {
  const player = hand.players.find(p => p.seatIndex === seatIndex);
  return {
    type: 'your_hole_cards',
    holeCards: player ? player.holeCards : [],
  };
}

/**
 * Get the full reconnection snapshot for a specific player.
 */
function getReconnectionSnapshot(hand, seatIndex) {
  const publicState = getPublicState(hand);
  const privateState = getPrivateState(hand, seatIndex);
  
  return {
    ...publicState,
    holeCards: privateState.holeCards,
  };
}

/**
 * Shuffle a deck array in-place (Fisher-Yates).
 */
function shuffleDeck(deck) {
  const d = [...deck];
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

/**
 * Handle a player action (fold/check/call/raise/all-in).
 * Returns { hand, error } where error is null if valid.
 * NOTE: This is the Phase 4 action handler — basic implementation here
 * for the state machine, but full validation in Phase 4.
 */
function handleAction(hand, seatIndex, action, amount) {
  // Reject actions on completed hands
  if (hand.gameStatus === GAME_STATES.HAND_COMPLETE) {
    return { hand, error: 'Hand is already complete' };
  }

  const playerIndex = hand.players.findIndex(p => p.seatIndex === seatIndex);
  
  if (playerIndex === -1) {
    return { hand, error: 'Player not in this hand' };
  }

  const player = hand.players[playerIndex];

  // Validate it's this player's turn
  if (playerIndex !== hand.currentPlayerIndex) {
    return { hand, error: 'Not your turn' };
  }

  // Validate player hasn't folded
  if (player.isFolded) {
    return { hand, error: 'Already folded' };
  }

  // Validate player isn't all-in
  if (player.isAllIn) {
    return { hand, error: 'Already all-in' };
  }

  switch (action) {
    case 'fold':
      player.isFolded = true;
      player.hasActed = true;
      break;

    case 'check':
      if (hand.currentBet > player.roundBet) {
        return { hand, error: 'Cannot check, must call or raise' };
      }
      player.hasActed = true;
      break;

    case 'call': {
      const callAmount = Math.min(hand.currentBet - player.roundBet, player.stack);
      player.stack -= callAmount;
      player.betAmount += callAmount;
      player.roundBet += callAmount;
      player.hasActed = true;
      hand.pot += callAmount;
      if (player.stack <= 0) {
        player.isAllIn = true;
      }
      break;
    }

    case 'raise':
    case 'bet': {
      if (!amount || amount <= 0) {
        return { hand, error: 'Invalid bet amount' };
      }

      if (action === 'raise') {
        if (hand.currentBet === 0) {
          return { hand, error: 'Cannot raise, no bet to raise' };
        }
        // Validate minimum raise: total must be >= currentBet + minRaise
        const minTotal = hand.currentBet + hand.minRaise;
        if (amount < minTotal && amount < player.stack + player.roundBet) {
          return { hand, error: 'Minimum raise not met' };
        }
      } else {
        // Bet (first bet in the round)
        if (hand.currentBet > 0) {
          return { hand, error: 'Already a bet, use raise' };
        }
      }

      // Calculate how much the player needs to put in total
      const totalBet = Math.max(amount, hand.currentBet);
      const cost = Math.min(totalBet - player.roundBet, player.stack);
      
      if (cost <= 0) {
        // Already matched, no additional bet needed
        player.hasActed = true;
        break;
      }

      const newRoundBet = player.roundBet + cost;
      player.stack -= cost;
      player.betAmount += cost;
      player.roundBet = newRoundBet;
      hand.pot += cost;

      // Update current bet if this player increased it
      if (newRoundBet > hand.currentBet) {
        hand.currentBet = newRoundBet;
        hand.minRaise = hand.bigBlind; // Simplified: reset to big blind
        hand.lastRaiserIndex = playerIndex;
      }
      
      player.hasActed = true;
      if (player.stack <= 0) {
        player.isAllIn = true;
      }
      break;
    }

    default:
      return { hand, error: `Unknown action: ${action}` };
  }

  // Check for all-in
  if (player.stack <= 0 && action !== 'fold') {
    player.isAllIn = true;
  }

  // Check if round is complete
  if (isRoundComplete(hand)) {
    // Keep advancing streets while the round is still complete. This handles
    // all-in runouts: when everyone remaining is all-in there is nobody left
    // to act, so we deal the remaining streets straight through to showdown.
    // Without this loop the hand would stall mid-hand (e.g. stuck on the flop)
    // with currentPlayerIndex = -1 and no one to trigger the next street.
    while (isRoundComplete(hand) && hand.gameStatus !== GAME_STATES.SHOWDOWN && !isHandComplete(hand)) {
      if (hand.gameStatus === GAME_STATES.RIVER || hand.players.filter(p => !p.isFolded).length <= 1) {
        goToShowdown(hand);
      } else {
        advanceStreet(hand);
      }
    }
  } else {
    // Move to next player
    hand.currentPlayerIndex = getNextActivePlayerIndex(hand, playerIndex);
    hand.actionStartTime = Date.now();
  }

  return { hand, error: null };
}

module.exports = {
  GAME_STATES,
  createHand,
  startHand,
  getNextActivePlayerIndex,
  isRoundComplete,
  advanceStreet,
  goToShowdown,
  isHandComplete,
  getPublicState,
  getPrivateState,
  getReconnectionSnapshot,
  handleAction,
};
