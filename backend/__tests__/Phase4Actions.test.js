const {
  GAME_STATES, createHand, startHand, handleAction,
  getNextActivePlayerIndex, isRoundComplete, advanceStreet
} = require('../GameHand');

function createClubState() {
  return {
    id: 'test-club-1',
    seats: [
      { userId: 'u1', userName: 'Alice', stack: 1500, isConnected: true },
      { userId: 'u2', userName: 'Bob', stack: 1500, isConnected: true },
      { userId: 'u3', userName: 'Charlie', stack: 1500, isConnected: true },
      null, null, null,
    ],
    hostId: 'u1',
    tableSettings: { sb: 10, bb: 20, startingStack: 1500, timer: 20, allowRebuys: true },
  };
}

describe('Phase 4 - Action Edge Cases', () => {
  describe('All-in scenarios', () => {
    test('player can go all-in for less than minimum raise', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);

      // Alice (dealer, first to act) has 1500 stack, goes all-in with small amount
      // But wait - first action is after BB, currentBet = 20
      // To go all-in with a raise, amount must be >= currentBet + minRaise
      // Unless the player doesn't have enough chips to meet the minimum
      
      // Let's modify: give first player only 25 chips remaining
      const aliceIdx = hand.currentPlayerIndex;
      hand.players[aliceIdx].stack = 25;
      const seatIdx = hand.players[aliceIdx].seatIndex;
      
      // Alice wants to raise to 25 (all-in). Since 25 < 40 (20+20), but
      // she can't afford the minimum raise, this should be accepted as all-in
      const result = handleAction(hand, seatIdx, 'raise', 25);
      expect(result.error).toBeNull();
      
      const alice = hand.players[aliceIdx];
      expect(alice.isAllIn).toBe(true);
      expect(alice.stack).toBe(0);
    });

    test('all-in player is skipped in turn order', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);

      // Make first player all-in
      const firstIdx = hand.currentPlayerIndex;
      hand.players[firstIdx].isAllIn = true;
      hand.players[firstIdx].stack = 0;
      hand.players[firstIdx].hasActed = true;

      // Next active should wrap around to the next non-all-in player
      const nextIdx = getNextActivePlayerIndex(hand, firstIdx);
      expect(nextIdx).not.toBe(firstIdx);
      expect(hand.players[nextIdx].isAllIn).toBe(false);
    });

    test('multiple all-ins can happen in same round', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);

      // Have the first two players go all-in
      for (let i = 0; i < 2; i++) {
        const seatIdx = hand.players[hand.currentPlayerIndex].seatIndex;
        const stack = hand.players[hand.currentPlayerIndex].stack;
        const result = handleAction(hand, seatIdx, 'raise', stack + hand.players[hand.currentPlayerIndex].betAmount);
        expect(result.error).toBeNull();
      }
    });

    test('all-in runout deals remaining streets to showdown (does not stall at flop)', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);

      // Every player shoves all-in
      let guard = 0;
      while (hand.gameStatus !== GAME_STATES.HAND_COMPLETE && guard < 10) {
        guard++;
        const pIdx = hand.currentPlayerIndex;
        if (pIdx < 0) break; // no one left to act — the bug stalls here
        const p = hand.players[pIdx];
        const allInTotal = p.roundBet + p.stack;
        const r = handleAction(hand, p.seatIndex, 'raise', allInTotal);
        if (r.error) handleAction(hand, p.seatIndex, 'call');
      }

      // The hand must run out all five community cards and reach showdown
      expect(hand.gameStatus).toBe(GAME_STATES.HAND_COMPLETE);
      expect(hand.communityCards.length).toBe(5);
      expect(hand.handResult).toBeDefined();
      expect(hand.pot).toBeGreaterThan(0);
    });
  });

  describe('Minimum raise validation', () => {
    test('rejects raise below minimum', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);

      const seatIdx = hand.players[hand.currentPlayerIndex].seatIndex;
      // currentBet is 20, minRaise is 20, so minimum total is 40
      // Try to raise to 30 (which is < 40)
      const result = handleAction(hand, seatIdx, 'raise', 30);
      expect(result.error).toBe('Minimum raise not met');
    });

    test('accepts raise at exactly minimum', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);

      const seatIdx = hand.players[hand.currentPlayerIndex].seatIndex;
      // The minimum total is 40 (20 + 20)
      const result = handleAction(hand, seatIdx, 'raise', 40);
      expect(result.error).toBeNull();
    });

    test('after a raise, minimum is updated', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);

      // First raise to 40
      const p1 = hand.currentPlayerIndex;
      const s1 = hand.players[p1].seatIndex;
      handleAction(hand, s1, 'raise', 40);

      // Next player
      const p2 = hand.currentPlayerIndex;
      const s2 = hand.players[p2].seatIndex;

      // Minimum raise should be based on bb (simplified)
      // So min would be 40 + 20 = 60
      const result = handleAction(hand, s2, 'raise', 50);
      expect(result.error).toBe('Minimum raise not met');

      // 60 should work
      const result2 = handleAction(hand, s2, 'raise', 60);
      expect(result2.error).toBeNull();
    });
  });

  describe('Round completion edge cases', () => {
    test('round completes when all players are all-in', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);

      // Set all players as all-in
      for (const p of hand.players) {
        p.isAllIn = true;
        p.hasActed = true;
      }

      expect(isRoundComplete(hand)).toBe(true);
    });

    test('round does not complete if some havent acted', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);

      // Only one player has acted
      hand.players[0].hasActed = true;
      hand.players[0].roundBet = hand.currentBet;

      expect(isRoundComplete(hand)).toBe(false);
    });

    test('round completes when all non-all-in players have acted and matched', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);

      // Mark all players with roundBet == currentBet and hasActed
      for (const p of hand.players) {
        p.roundBet = hand.currentBet;
        p.hasActed = true;
      }

      expect(isRoundComplete(hand)).toBe(true);
    });
  });

  describe('Call edge cases', () => {
    test('call deducts correct amount', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);

      const pIdx = hand.currentPlayerIndex;
      const stackBefore = hand.players[pIdx].stack;
      const roundBetBefore = hand.players[pIdx].roundBet;

      const seatIdx = hand.players[pIdx].seatIndex;
      const result = handleAction(hand, seatIdx, 'call');

      expect(result.error).toBeNull();
      // currentBet is 20, roundBet was 0, so call should be 20
      expect(hand.players[pIdx].roundBet - roundBetBefore).toBe(20);
      expect(stackBefore - hand.players[pIdx].stack).toBe(20);
    });

    test('call can put player all-in', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);

      const pIdx = hand.currentPlayerIndex;
      // Set the player's stack to less than the call amount
      hand.players[pIdx].stack = 5;

      const seatIdx = hand.players[pIdx].seatIndex;
      const result = handleAction(hand, seatIdx, 'call');

      expect(result.error).toBeNull();
      expect(hand.players[pIdx].stack).toBe(0);
      expect(hand.players[pIdx].isAllIn).toBe(true);
      expect(hand.players[pIdx].roundBet).toBe(5);
    });
  });

  describe('Fold edge cases', () => {
    test('folded player cannot act again', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);

      const pIdx = hand.currentPlayerIndex;
      const seatIdx = hand.players[pIdx].seatIndex;

      // First fold
      const r1 = handleAction(hand, seatIdx, 'fold');
      expect(r1.error).toBeNull();

      // Since the player folded, the turn has moved on
      // Trying to fold again should be "Not your turn"
      const r2 = handleAction(hand, seatIdx, 'fold');
      expect(r2.error).toBe('Not your turn');
    });

    test('folding when only remaining player wins', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);

      // Fold player 1 and 2
      for (let i = 0; i < 2; i++) {
        const seatIdx = hand.players[hand.currentPlayerIndex].seatIndex;
        handleAction(hand, seatIdx, 'fold');
      }

      // After 2 folds, only 1 player remains, round should be complete
      expect(isRoundComplete(hand)).toBe(true);
    });
  });

  describe('Full hand simulation', () => {
    test('complete preflop round advances to flop', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);

      // All players call
      for (let i = 0; i < 3; i++) {
        const seatIdx = hand.players[hand.currentPlayerIndex].seatIndex;
        handleAction(hand, seatIdx, 'call');
      }

      expect(hand.gameStatus).toBe(GAME_STATES.FLOP);
      expect(hand.communityCards.length).toBe(3);
    });

    test('full flop round advances to turn', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);

      // Pre-flop: everyone calls
      for (let i = 0; i < 3; i++) {
        const seatIdx = hand.players[hand.currentPlayerIndex].seatIndex;
        handleAction(hand, seatIdx, 'call');
      }

      // Now on FLOP - everyone checks
      for (let i = 0; i < 3; i++) {
        const seatIdx = hand.players[hand.currentPlayerIndex].seatIndex;
        handleAction(hand, seatIdx, 'check');
      }

      expect(hand.gameStatus).toBe(GAME_STATES.TURN);
      expect(hand.communityCards.length).toBe(4);
    });

    test('raise and re-raise on flop', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);

      // Pre-flop: everyone calls
      for (let i = 0; i < 3; i++) {
        const seatIdx = hand.players[hand.currentPlayerIndex].seatIndex;
        handleAction(hand, seatIdx, 'call');
      }

      // Now on FLOP
      // First player bets 40
      const p1 = hand.currentPlayerIndex;
      const s1 = hand.players[p1].seatIndex;
      const r1 = handleAction(hand, s1, 'bet', 40);
      expect(r1.error).toBeNull();

      // Second player raises to 100
      const p2 = hand.currentPlayerIndex;
      const s2 = hand.players[p2].seatIndex;
      const r2 = handleAction(hand, s2, 'raise', 100);
      expect(r2.error).toBeNull();

      // Third player calls 100
      const p3 = hand.currentPlayerIndex;
      const s3 = hand.players[p3].seatIndex;
      const r3 = handleAction(hand, s3, 'call');
      expect(r3.error).toBeNull();

      // Back to first player - needs to call 60 more (100 - 40)
      const p4 = hand.currentPlayerIndex;
      const s4 = hand.players[p4].seatIndex;
      const r4 = handleAction(hand, s4, 'call');
      expect(r4.error).toBeNull();

      // Round should be complete, advance to turn
      expect(hand.gameStatus).toBe(GAME_STATES.TURN);
      expect(hand.communityCards.length).toBe(4);
    });

    test('check after raise resets on new street', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);

      // Pre-flop: call, call, call
      for (let i = 0; i < 3; i++) {
        const seatIdx = hand.players[hand.currentPlayerIndex].seatIndex;
        handleAction(hand, seatIdx, 'call');
      }

      // Now on FLOP - everyone should be able to check
      // (currentBet was reset to 0 by advanceStreet)
      for (let i = 0; i < 3; i++) {
        const seatIdx = hand.players[hand.currentPlayerIndex].seatIndex;
        expect(hand.currentBet).toBe(0); // Reset for new street
        handleAction(hand, seatIdx, 'check');
      }

      expect(hand.gameStatus).toBe(GAME_STATES.TURN);
    });
  });
});
