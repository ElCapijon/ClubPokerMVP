const { 
  GAME_STATES, createHand, startHand, getNextActivePlayerIndex, 
  isRoundComplete, advanceStreet, goToShowdown, handleAction, 
  getPublicState, getReconnectionSnapshot 
} = require('../GameHand');

// Helper: create a minimal club state for testing
function createClubState(handCount = 0) {
  return {
    id: 'test-club-1',
    seats: [
      { userId: 'u1', userName: 'Alice', stack: 1500, isConnected: true },
      { userId: 'u2', userName: 'Bob', stack: 1500, isConnected: true },
      { userId: 'u3', userName: 'Charlie', stack: 1500, isConnected: true },
      null,
      null,
      null,
    ],
    hostId: 'u1',
    tableSettings: {
      sb: 10,
      bb: 20,
      startingStack: 1500,
      timer: 20,
      allowRebuys: true,
    },
  };
}

describe('GameHand', () => {
  describe('createHand', () => {
    test('creates a hand with active players', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      
      expect(hand).not.toBeNull();
      expect(hand.players.length).toBe(3);
      expect(hand.gameStatus).toBe(GAME_STATES.PREFLOP);
    });

    test('returns null with fewer than 2 players', () => {
      const club = createClubState();
      club.seats = [
        { userId: 'u1', userName: 'Alice', stack: 1500, isConnected: true },
        null, null, null, null, null,
      ];
      const hand = createHand(club, 0);
      expect(hand).toBeNull();
    });

    test('skips disconnected players', () => {
      const club = createClubState();
      club.seats[1] = { userId: 'u2', userName: 'Bob', stack: 1500, isConnected: false };
      const hand = createHand(club, 0);
      expect(hand.players.length).toBe(2);
      expect(hand.players.every(p => p.isConnected)).toBe(true);
    });

    test('rotates dealer based on hand count', () => {
      const club = createClubState();
      
      const hand0 = createHand(club, 0);
      expect(hand0.dealerPlayerIndex).toBe(0);
      
      const hand1 = createHand(club, 1);
      expect(hand1.dealerPlayerIndex).toBe(1);
      
      const hand2 = createHand(club, 2);
      expect(hand2.dealerPlayerIndex).toBe(2);
      
      // Wraps around
      const hand3 = createHand(club, 3);
      expect(hand3.dealerPlayerIndex).toBe(0);
    });

    test('hand has correct structure', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      
      expect(hand).toHaveProperty('clubId');
      expect(hand).toHaveProperty('handId');
      expect(hand).toHaveProperty('gameStatus');
      expect(hand).toHaveProperty('players');
      expect(hand).toHaveProperty('communityCards');
      expect(hand).toHaveProperty('pot');
      expect(hand).toHaveProperty('currentBet');
      expect(hand).toHaveProperty('smallBlind');
      expect(hand).toHaveProperty('bigBlind');
      expect(hand).toHaveProperty('dealerPlayerIndex');
      expect(hand).toHaveProperty('currentPlayerIndex');
      
      expect(hand.pot).toBe(0);
      expect(hand.communityCards).toEqual([]);
      expect(hand.smallBlind).toBe(10);
      expect(hand.bigBlind).toBe(20);
    });
  });

  describe('startHand', () => {
    test('deals 2 hole cards to each player', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);
      
      for (const player of hand.players) {
        expect(player.holeCards.length).toBe(2);
      }
    });

    test('all hole cards are unique', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);
      
      const allCards = hand.players.flatMap(p => p.holeCards);
      const keys = new Set(allCards.map(c => c.key));
      expect(keys.size).toBe(allCards.length);
    });

    test('posts blinds correctly', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);
      
      // SB is player after dealer (dealer = player 0, SB = player 1)
      const sbPlayer = hand.players[1];
      const bbPlayer = hand.players[2];
      
      expect(sbPlayer.betAmount).toBe(10);
      expect(bbPlayer.betAmount).toBe(20);
      expect(sbPlayer.stack).toBe(1490);
      expect(bbPlayer.stack).toBe(1480);
    });

    test('blinds are deducted from stacks', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);
      
      const totalBets = hand.players.reduce((sum, p) => sum + p.betAmount, 0);
      expect(totalBets).toBe(30); // 10 + 20
      expect(hand.pot).toBe(30);
    });

    test('sets current turn to player after BB', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);
      
      // dealer=0, SB=1, BB=2, first action = player after BB = player 0 (dealer)
      expect(hand.currentPlayerIndex).toBe(0);
      // But wait, dealer is player 0, SB is next active = 1, BB is next = 2
      // Current turn should be next after BB = wraps to dealer = 0
      // But dealer (player 0) has acted? No, only SB and BB have acted.
      // Actually the first turn is after BB, which is player 0 (dealer) in a 3-player game
      expect(hand.currentPlayerIndex).toBe(0);
    });

    test('currentBet is set to big blind', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);
      
      expect(hand.currentBet).toBe(20);
      expect(hand.lastRaiserIndex).toBe(2); // BB is last raiser
    });
  });

  describe('getNextActivePlayerIndex', () => {
    test('finds next player clockwise', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);
      
      const next = getNextActivePlayerIndex(hand, 0);
      expect(next).toBe(1);
    });

    test('wraps around to beginning', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      
      const next = getNextActivePlayerIndex(hand, 2);
      expect(next).toBe(0);
    });

    test('skips folded players', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      hand.players[1].isFolded = true;
      
      const next = getNextActivePlayerIndex(hand, 0);
      expect(next).toBe(2); // Skips player 1
    });

    test('skips all-in players', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      hand.players[1].isAllIn = true;
      
      const next = getNextActivePlayerIndex(hand, 0);
      expect(next).toBe(2); // Skips player 1
    });
  });

  describe('isRoundComplete', () => {
    test('returns false if some players have not acted', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);
      
      // After dealing, SB and BB have acted, dealer has not
      expect(isRoundComplete(hand)).toBe(false);
    });

    test('returns true if all players have acted and matched bet', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);
      
      // Mark all players as having acted with matched bets
      for (const player of hand.players) {
        player.hasActed = true;
        player.roundBet = hand.currentBet;
      }
      
      expect(isRoundComplete(hand)).toBe(true);
    });

    test('returns true if only one player remains', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);
      
      hand.players[1].isFolded = true;
      hand.players[2].isFolded = true;
      
      expect(isRoundComplete(hand)).toBe(true);
    });

    test('returns true if all remaining players are all-in', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);
      
      hand.players[0].isAllIn = true;
      hand.players[1].isAllIn = true;
      hand.players[2].isFolded = true;
      
      expect(isRoundComplete(hand)).toBe(true);
    });
  });

  describe('advanceStreet', () => {
    test('advances from PREFLOP to FLOP', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);
      
      advanceStreet(hand);
      expect(hand.gameStatus).toBe(GAME_STATES.FLOP);
    });

    test('deals 3 community cards on flop', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);
      
      advanceStreet(hand);
      expect(hand.communityCards.length).toBe(3);
    });

    test('advances from FLOP to TURN with 1 more card', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);
      
      advanceStreet(hand); // PREFLOP → FLOP
      advanceStreet(hand); // FLOP → TURN
      
      expect(hand.gameStatus).toBe(GAME_STATES.TURN);
      expect(hand.communityCards.length).toBe(4);
    });

    test('advances from TURN to RIVER with 5 cards', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);
      
      advanceStreet(hand); // PREFLOP → FLOP
      advanceStreet(hand); // FLOP → TURN
      advanceStreet(hand); // TURN → RIVER
      
      expect(hand.gameStatus).toBe(GAME_STATES.RIVER);
      expect(hand.communityCards.length).toBe(5);
    });

    test('advances from RIVER to SHOWDOWN', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);
      
      advanceStreet(hand); // PREFLOP → FLOP
      advanceStreet(hand); // FLOP → TURN
      advanceStreet(hand); // TURN → RIVER
      advanceStreet(hand); // RIVER → SHOWDOWN
      
      expect(hand.gameStatus).toBe(GAME_STATES.SHOWDOWN);
    });

    test('resets round bets and hasActed flags', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);
      
      // Mark some state
      hand.players[0].roundBet = 50;
      hand.players[0].hasActed = true;
      
      advanceStreet(hand);
      
      for (const player of hand.players) {
        expect(player.roundBet).toBe(0);
        expect(player.hasActed).toBe(false);
      }
    });
  });

  describe('goToShowdown', () => {
    test('handles uncontested hand (everyone folded except one)', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);
      
      hand.players[0].isFolded = true;
      hand.players[1].isFolded = true;
      // Player 2 is the only one left
      
      goToShowdown(hand);
      
      expect(hand.gameStatus).toBe(GAME_STATES.HAND_COMPLETE);
      expect(hand.handResult).toBeDefined();
      expect(hand.handResult.length).toBe(1);
      expect(hand.handResult[0].winners.length).toBe(1);
      expect(hand.handResult[0].winners[0].seatIndex).toBe(hand.players[2].seatIndex);
    });

    test('handles showdown with multiple players', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);
      
      // Give player 0 a pair of Aces
      hand.players[0].holeCards = [
        { suit: 'hearts', rankName: 'A', value: 14, key: 'AH', suitSymbol: '♥' },
        { suit: 'spades', rankName: 'A', value: 14, key: 'AS', suitSymbol: '♠' },
      ];
      
      // Player 1 gets nothing
      hand.players[1].holeCards = [
        { suit: 'clubs', rankName: '2', value: 2, key: '2C', suitSymbol: '♣' },
        { suit: 'diamonds', rankName: '7', value: 7, key: '7D', suitSymbol: '♦' },
      ];
      
      // Player 2 gets nothing
      hand.players[2].holeCards = [
        { suit: 'hearts', rankName: '3', value: 3, key: '3H', suitSymbol: '♥' },
        { suit: 'spades', rankName: '8', value: 8, key: '8S', suitSymbol: '♠' },
      ];
      
      // Add community cards (all low, no pair for 1 and 2)
      hand.communityCards = [
        { suit: 'diamonds', rankName: '5', value: 5, key: '5D', suitSymbol: '♦' },
        { suit: 'clubs', rankName: '6', value: 6, key: '6C', suitSymbol: '♣' },
        { suit: 'hearts', rankName: '9', value: 9, key: '9H', suitSymbol: '♥' },
        { suit: 'spades', rankName: '10', value: 10, key: '10S', suitSymbol: '♠' },
        { suit: 'clubs', rankName: 'J', value: 11, key: 'JC', suitSymbol: '♣' },
      ];
      
      // Set equal bet amounts so everyone is eligible for the pot
      for (const p of hand.players) {
        p.betAmount = 20;
        p.roundBet = 20;
        hand.pot = 60;
      }
      
      goToShowdown(hand);
      
      expect(hand.gameStatus).toBe(GAME_STATES.HAND_COMPLETE);
      expect(hand.handResult).toBeDefined();
      // Player 0 should win with pair of Aces
      const firstWinner = hand.handResult[0].winners[0];
      expect(firstWinner.seatIndex).toBe(hand.players[0].seatIndex);
    });
  });

  describe('handleAction', () => {
    test('handles fold action', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);
      
      const seatIndex = hand.players[hand.currentPlayerIndex].seatIndex;
      const result = handleAction(hand, seatIndex, 'fold');
      
      expect(result.error).toBeNull();
      expect(hand.players[hand.currentPlayerIndex].isFolded).toBe(false); // shouldn't be this one
      const foldedPlayer = hand.players.find(p => p.seatIndex === seatIndex);
      expect(foldedPlayer.isFolded).toBe(true);
    });

    test('handles call action', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);
      
      // First player to act (after BB)
      const currentIdx = hand.currentPlayerIndex;
      const seatIndex = hand.players[currentIdx].seatIndex;
      const stackBefore = hand.players[currentIdx].stack;
      
      const result = handleAction(hand, seatIndex, 'call');
      
      expect(result.error).toBeNull();
      // Should have matched the current bet
      expect(hand.players[currentIdx].roundBet).toBe(hand.currentBet);
      expect(hand.players[currentIdx].stack).toBeLessThan(stackBefore);
    });

    test('handles check action when no bet to call', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);
      
      // Reset the current bet to 0 (as if everyone has matched)
      hand.currentBet = 0;
      const currentIdx = hand.currentPlayerIndex;
      const seatIndex = hand.players[currentIdx].seatIndex;
      
      const result = handleAction(hand, seatIndex, 'check');
      
      // Check succeeds (no error)
      expect(result.error).toBeNull();
      // The round completes (everyone matched currentBet=0) and advances to flop
      expect(hand.gameStatus).toBe(GAME_STATES.FLOP);
    });

    test('rejects check when there is a bet to call', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);
      
      const currentIdx = hand.currentPlayerIndex;
      const seatIndex = hand.players[currentIdx].seatIndex;
      // currentBet is already 20 from BB
      
      const result = handleAction(hand, seatIndex, 'check');
      
      expect(result.error).toBe('Cannot check, must call or raise');
    });

    test('rejects action when not your turn', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);
      
      // Try to act as a player whose turn it is NOT
      const wrongSeat = hand.players.find(p => 
        hand.players.indexOf(p) !== hand.currentPlayerIndex
      ).seatIndex;
      
      const result = handleAction(hand, wrongSeat, 'fold');
      
      expect(result.error).toBe('Not your turn');
    });

    test('handles raise action', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);
      
      const currentIdx = hand.currentPlayerIndex;
      const seatIndex = hand.players[currentIdx].seatIndex;
      
      const result = handleAction(hand, seatIndex, 'raise', 40);
      
      expect(result.error).toBeNull();
      expect(hand.pot).toBe(70); // 40 raise + 30 blinds
    });

    test('advances street when round complete after action', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);
      
      // Have all players act (call) to complete the preflop round
      for (let i = 0; i < 3; i++) {
        const seatIdx = hand.players[hand.currentPlayerIndex].seatIndex;
        handleAction(hand, seatIdx, 'call');
      }
      
      // After everyone calls, round should advance to flop
      expect(hand.gameStatus).toBe(GAME_STATES.FLOP);
      expect(hand.communityCards.length).toBe(3);
    });
  });

  describe('getPublicState', () => {
    test('returns public state without hole cards', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);
      
      const state = getPublicState(hand);
      
      expect(state.type).toBe('game_state_sync');
      expect(state.handId).toBeDefined();
      expect(state.gameStatus).toBe(GAME_STATES.PREFLOP);
      expect(state.communityCards).toBeDefined();
      expect(state.pot).toBe(30);
      expect(state.players).toBeDefined();
      
      // Should NOT include hole cards
      for (const p of state.players) {
        expect(p.holeCards).toBeUndefined();
      }
    });
  });

  describe('getReconnectionSnapshot', () => {
    test('includes hole cards for the requesting player', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);
      
      const seatIndex = hand.players[0].seatIndex;
      const snapshot = getReconnectionSnapshot(hand, seatIndex);
      
      expect(snapshot.holeCards).toBeDefined();
      expect(snapshot.holeCards.length).toBe(2);
      expect(snapshot.gameStatus).toBe(GAME_STATES.PREFLOP);
    });
  });
});
