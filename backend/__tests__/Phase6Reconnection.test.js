const { createHand, startHand, getReconnectionSnapshot, getPublicState, getPrivateState } = require('../GameHand');

function createClubState() {
  return {
    id: 'test-club-reconnect',
    seats: [
      { userId: 'u1', userName: 'Alice', stack: 1500, isConnected: true, isSittingOut: false },
      { userId: 'u2', userName: 'Bob', stack: 1500, isConnected: true, isSittingOut: false },
      { userId: 'u3', userName: 'Charlie', stack: 1500, isConnected: true, isSittingOut: false },
      null, null, null,
    ],
    hostId: 'u1',
    tableSettings: { sb: 10, bb: 20, startingStack: 1500, timer: 20, allowRebuys: true },
  };
}

describe('Phase 6 - Reconnection', () => {
  describe('getReconnectionSnapshot', () => {
    test('includes public state for reconnecting player', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);

      // Get snapshot for Alice (seat 0)
      const snapshot = getReconnectionSnapshot(hand, 0);

      expect(snapshot).toBeDefined();
      expect(snapshot.type).toBe('game_state_sync');
      expect(snapshot.gameStatus).toBe('PREFLOP');
      expect(snapshot.communityCards).toEqual([]);
      expect(snapshot.pot).toBe(30);
      expect(snapshot.currentBet).toBe(20);
    });

    test('includes hole cards only for the requesting player', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);

      // Get snapshot for Alice (seat 0)
      const snapshot = getReconnectionSnapshot(hand, 0);
      expect(snapshot.holeCards).toBeDefined();
      expect(snapshot.holeCards.length).toBe(2);
      
      // The hole cards should be Alice's actual cards
      expect(snapshot.holeCards[0].key).toBe(hand.players[0].holeCards[0].key);
      expect(snapshot.holeCards[1].key).toBe(hand.players[0].holeCards[1].key);
    });

    test('does not include other players hole cards', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);

      const snapshot = getReconnectionSnapshot(hand, 0);
      
      // Other players should not have holeCards in the snapshot
      for (const p of snapshot.players) {
        if (p.seatIndex !== 0) { // Not Alice
          expect(p.holeCards).toBeUndefined();
        }
      }
    });

    test('returns correct game state mid-hand', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);

      // Manually advance to flop to test mid-hand state
      hand.communityCards = [
        { suit: 'hearts', rankName: 'A', value: 14, key: 'AH', suitSymbol: '♥' },
        { suit: 'spades', rankName: 'K', value: 13, key: 'KS', suitSymbol: '♠' },
        { suit: 'diamonds', rankName: 'Q', value: 12, key: 'QD', suitSymbol: '♦' },
      ];
      hand.gameStatus = 'FLOP';
      hand.pot = 45;

      const snapshot = getReconnectionSnapshot(hand, 1); // Bob reconnects
      expect(snapshot.gameStatus).toBe('FLOP');
      expect(snapshot.communityCards.length).toBe(3);
      expect(snapshot.pot).toBe(45);
    });
  });

  describe('getPublicState', () => {
    test('public state has no hole cards for any player', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);

      const state = getPublicState(hand);
      for (const p of state.players) {
        expect(p.holeCards).toBeUndefined();
      }
    });
  });

  describe('getPrivateState', () => {
    test('returns hole cards for the specified seat', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);

      const privateState = getPrivateState(hand, 0); // Alice
      expect(privateState.type).toBe('your_hole_cards');
      expect(privateState.holeCards.length).toBe(2);
    });

    test('returns empty array for unknown seat', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);

      const privateState = getPrivateState(hand, 99); // Doesn't exist
      expect(privateState.holeCards).toEqual([]);
    });
  });

  describe('Disconnected player state', () => {
    test('players with 0 stack are skipped in new hands', () => {
      const club = createClubState();
      club.seats[0].stack = 0; // Alice busted

      const hand = createHand(club, 1);
      expect(hand.players.length).toBe(2); // Only Bob and Charlie
      expect(hand.players.find(p => p.userName === 'Alice')).toBeUndefined();
    });

    test('players sitting out are skipped in new hands', () => {
      const club = createClubState();
      club.seats[0].isSittingOut = true; // Alice sitting out

      const hand = createHand(club, 2);
      expect(hand.players.length).toBe(2); // Only Bob and Charlie
    });

    test('rejoining player can sit back in', () => {
      const club = createClubState();
      club.seats[0].isSittingOut = false; // Alice re-joins
      club.seats[0].stack = 1500; // Has chips

      const hand = createHand(club, 3);
      expect(hand.players.length).toBe(3); // All three back
      expect(hand.players.find(p => p.userName === 'Alice')).toBeDefined();
    });
  });
});
