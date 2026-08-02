const {
  GAME_STATES, createHand, startHand, handleAction,
  getNextActivePlayerIndex, isRoundComplete, isHandComplete,
  advanceStreet, advanceCompleteRounds, advanceCompleteRoundStep,
  applyShowdownDecision
} = require('../GameHand');

/** Resolve the interactive showdown reveal phase (everyone shows). */
function completeShowdown(hand) {
  let guard = 0;
  while (hand.gameStatus === GAME_STATES.SHOWDOWN && guard < 10) {
    guard++;
    const seat = hand.showdown.queue[hand.showdown.queuePos];
    const r = applyShowdownDecision(hand, seat, true);
    if (r.error) throw new Error(`Showdown decision failed: ${r.error}`);
  }
}

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
      while (guard < 10) {
        guard++;
        const pIdx = hand.currentPlayerIndex;
        if (pIdx < 0) break; // no one left to act
        const p = hand.players[pIdx];
        const allInTotal = p.roundBet + p.stack;
        const r = handleAction(hand, p.seatIndex, 'raise', allInTotal);
        if (r.error) handleAction(hand, p.seatIndex, 'call');
      }

      // handleAction only deals ONE street; the orchestrator (scheduleRunout)
      // drives the rest one step at a time. Simulate that loop here.
      let streetGuard = 0;
      while (!isHandComplete(hand) && streetGuard < 6) {
        streetGuard++;
        advanceCompleteRoundStep(hand);
      }

      // The hand must run out all five community cards and reach showdown
      expect(hand.gameStatus).toBe(GAME_STATES.HAND_COMPLETE);
      expect(hand.communityCards.length).toBe(5);
      expect(hand.handResult).toBeDefined();
      expect(hand.pot).toBeGreaterThan(0);
    });

    test('all-in runout deals streets one at a time (staged, not all at once)', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);

      // Every player shoves all-in preflop
      let guard = 0;
      while (guard < 10) {
        guard++;
        const pIdx = hand.currentPlayerIndex;
        if (pIdx < 0) break;
        const p = hand.players[pIdx];
        const r = handleAction(hand, p.seatIndex, 'raise', p.roundBet + p.stack);
        if (r.error) handleAction(hand, p.seatIndex, 'call');
      }

      // The completing shove deals exactly ONE street (the flop) — the rest
      // must be driven one step at a time so the server can broadcast each.
      expect(hand.gameStatus).toBe(GAME_STATES.FLOP);
      expect(hand.communityCards.length).toBe(3);

      advanceCompleteRoundStep(hand); // → turn
      expect(hand.gameStatus).toBe(GAME_STATES.TURN);
      expect(hand.communityCards.length).toBe(4);

      advanceCompleteRoundStep(hand); // → river
      expect(hand.gameStatus).toBe(GAME_STATES.RIVER);
      expect(hand.communityCards.length).toBe(5);

      advanceCompleteRoundStep(hand); // → showdown
      expect(hand.gameStatus).toBe(GAME_STATES.HAND_COMPLETE);
      expect(hand.handResult).toBeDefined();

      // Nothing left to advance after the hand is complete
      expect(advanceCompleteRoundStep(hand)).toBe(false);
    });

    test('lone live player vs two all-in opponents: board runs out, no betting round', () => {
      const club = createClubState();
      // Alice (1500) stays live; Bob and Charlie are short stacks that shove all-in
      club.seats[1] = { userId: 'u2', userName: 'Bob', stack: 200, isConnected: true };
      club.seats[2] = { userId: 'u3', userName: 'Charlie', stack: 200, isConnected: true };
      const hand = createHand(club, 0);
      startHand(hand);

      const aliceSeat = hand.players[0].seatIndex;
      const bobSeat = hand.players[1].seatIndex;
      const charlieSeat = hand.players[2].seatIndex;

      // Alice (UTG/dealer) calls the blind first
      let r = handleAction(hand, hand.players[hand.currentPlayerIndex].seatIndex, 'call');
      expect(r.error).toBeNull();

      // Bob shoves all-in to 200
      r = handleAction(hand, bobSeat, 'raise', 200);
      expect(r.error).toBeNull();

      // Charlie calls all-in (200)
      r = handleAction(hand, charlieSeat, 'call');
      expect(r.error).toBeNull();

      // Alice calls 200 — she stays live with chips left
      r = handleAction(hand, aliceSeat, 'call');
      expect(r.error).toBeNull();

      expect(hand.players[1].isAllIn).toBe(true);
      expect(hand.players[2].isAllIn).toBe(true);
      expect(hand.players[0].isAllIn).toBe(false);

      // Round completes and the flop is dealt — but Alice is NOT offered a
      // betting round: everyone else is all-in, so the board runs out.
      expect(hand.gameStatus).toBe(GAME_STATES.FLOP);
      expect(isRoundComplete(hand)).toBe(true);

      // Drive the staged runout to showdown — Alice never acts again
      let guard = 0;
      while (!isHandComplete(hand) && hand.gameStatus !== GAME_STATES.SHOWDOWN && guard < 6) {
        guard++;
        advanceCompleteRoundStep(hand);
      }
      // The lone live player must decide at the interactive showdown
      completeShowdown(hand);
      expect(hand.gameStatus).toBe(GAME_STATES.HAND_COMPLETE);
      expect(hand.communityCards.length).toBe(5);
      expect(hand.handResult).toBeDefined();
    });

    test('heads-up vs all-in opponent: live player matches, then board runs out', () => {
      const club = createClubState();
      club.seats[2] = null; // heads-up: Alice (BB/dealer) vs Bob (SB)
      club.seats[0] = { userId: 'u1', userName: 'Alice', stack: 3000, isConnected: true };
      const hand = createHand(club, 0);
      startHand(hand);

      // SB shoves all-in
      let r = handleAction(hand, hand.players[hand.currentPlayerIndex].seatIndex, 'raise', 1500);
      expect(r.error).toBeNull();

      // BB (Alice) calls — matches, but still has chips left (3000 stack)
      r = handleAction(hand, hand.players[hand.currentPlayerIndex].seatIndex, 'call');
      expect(r.error).toBeNull();

      expect(hand.players[1].isAllIn).toBe(true);
      expect(hand.players[0].isAllIn).toBe(false);

      // Flop dealt, round complete — the live BB is NOT asked to bet again
      expect(hand.gameStatus).toBe(GAME_STATES.FLOP);
      expect(isRoundComplete(hand)).toBe(true);

      let guard = 0;
      while (!isHandComplete(hand) && hand.gameStatus !== GAME_STATES.SHOWDOWN && guard < 6) {
        guard++;
        advanceCompleteRoundStep(hand);
      }
      // The lone live player must decide at the interactive showdown
      completeShowdown(hand);
      expect(hand.gameStatus).toBe(GAME_STATES.HAND_COMPLETE);
      expect(hand.communityCards.length).toBe(5);
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

  describe('Big blind pre-flop option', () => {
    test('BB gets a turn to act when everyone calls pre-flop', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);

      // Turn order pre-flop: Alice (UTG/dealer) → Bob (SB) → Charlie (BB)
      const bbSeat = hand.players[2].seatIndex; // Charlie is the BB

      // Alice and Bob call
      handleAction(hand, hand.players[hand.currentPlayerIndex].seatIndex, 'call');
      handleAction(hand, hand.players[hand.currentPlayerIndex].seatIndex, 'call');

      // Action must now return to the BB (they have the option), not skip to flop
      expect(hand.gameStatus).toBe(GAME_STATES.PREFLOP);
      expect(hand.players[hand.currentPlayerIndex].seatIndex).toBe(bbSeat);

      // BB can check (they already matched the blind)
      const result = handleAction(hand, bbSeat, 'check');
      expect(result.error).toBeNull();
      expect(hand.gameStatus).toBe(GAME_STATES.FLOP);
    });

    test('BB can raise pre-flop when action returns to them', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);

      const bbSeat = hand.players[2].seatIndex;

      // Alice and Bob call
      handleAction(hand, hand.players[hand.currentPlayerIndex].seatIndex, 'call');
      handleAction(hand, hand.players[hand.currentPlayerIndex].seatIndex, 'call');

      // BB raises to 60 (currentBet 20 + minRaise 20 = min total 40, so 60 is valid)
      const result = handleAction(hand, bbSeat, 'raise', 60);
      expect(result.error).toBeNull();
      expect(hand.currentBet).toBe(60);
      expect(hand.players[2].roundBet).toBe(60);
    });

    test('heads-up BB gets the option after SB calls', () => {
      const club = createClubState();
      club.seats[2] = null; // Remove Charlie → heads-up: Alice (BB/dealer) vs Bob (SB)
      const hand = createHand(club, 0);
      startHand(hand);

      expect(hand.players.length).toBe(2);
      // Dealer (player 0) is also the BB in heads-up; SB acts first
      const bbSeat = hand.players[0].seatIndex;

      // SB (Bob) calls — the only other player
      handleAction(hand, hand.players[hand.currentPlayerIndex].seatIndex, 'call');

      // BB must get the option to check/raise
      expect(hand.gameStatus).toBe(GAME_STATES.PREFLOP);
      expect(hand.players[hand.currentPlayerIndex].seatIndex).toBe(bbSeat);

      const result = handleAction(hand, bbSeat, 'check');
      expect(result.error).toBeNull();
      expect(hand.gameStatus).toBe(GAME_STATES.FLOP);
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

  describe('Short-stack blinds & all-in street progression', () => {
    test('SB posting a blind that empties their stack is marked all-in', () => {
      const club = createClubState();
      club.seats[1] = { userId: 'u2', userName: 'Bob', stack: 10, isConnected: true }; // exactly SB
      const hand = createHand(club, 0);
      startHand(hand);

      const sb = hand.players[1];
      expect(sb.stack).toBe(0);
      expect(sb.isAllIn).toBe(true);
    });

    test('BB posting a blind that empties their stack is marked all-in', () => {
      const club = createClubState();
      club.seats[2] = { userId: 'u3', userName: 'Charlie', stack: 20, isConnected: true }; // exactly BB
      const hand = createHand(club, 0);
      startHand(hand);

      const bb = hand.players[2];
      expect(bb.stack).toBe(0);
      expect(bb.isAllIn).toBe(true);
    });

    test('short-stack BB posts less than the blind but currentBet stays the FULL big blind', () => {
      const club = createClubState();
      // Charlie (BB) only has 5 chips but the big blind is 20 — he posts 5 all-in
      club.seats[2] = { userId: 'u3', userName: 'Charlie', stack: 5, isConnected: true };
      const hand = createHand(club, 0);
      startHand(hand);

      const bb = hand.players[2];
      expect(bb.stack).toBe(0);
      expect(bb.isAllIn).toBe(true);
      expect(bb.roundBet).toBe(5);

      // The amount to call is the full big blind (20), NOT the 5 the short BB posted.
      // The short blind only caps what the BB can win (side pot), never the bet level.
      expect(hand.currentBet).toBe(20);

      // First player to act (UTG/dealer) must call the full 20, not just 5
      const utgIdx = hand.currentPlayerIndex;
      const utgSeat = hand.players[utgIdx].seatIndex;
      const r = handleAction(hand, utgSeat, 'call');
      expect(r.error).toBeNull();
      expect(hand.players[utgIdx].roundBet).toBe(20);

      // SB also owes the difference up to the full blind: posted 10, must add 10 more
      const sbIdx = hand.currentPlayerIndex;
      const sbSeat = hand.players[sbIdx].seatIndex;
      const r2 = handleAction(hand, sbSeat, 'call');
      expect(r2.error).toBeNull();
      // SB total committed = 10 (blind) + 10 (top-up) = 20 (roundBet resets per street,
      // so assert the cumulative betAmount)
      expect(hand.players[sbIdx].betAmount).toBe(20);

      // Pot: SB 10 + BB 5 + UTG 20 + SB top-up 10 = 45
      expect(hand.pot).toBe(45);
      // Both live players matched the full 20 → preflop round completes → flop is dealt
      expect(hand.gameStatus).toBe(GAME_STATES.FLOP);
      expect(hand.communityCards.length).toBe(3);
    });

    test('short-stack BB (all-in from blind) is never asked to act; streets auto-advance', () => {
      const club = createClubState();
      club.seats[0] = { userId: 'u1', userName: 'Alice', stack: 100, isConnected: true };
      club.seats[1] = { userId: 'u2', userName: 'Bob', stack: 100, isConnected: true };
      club.seats[2] = { userId: 'u3', userName: 'Charlie', stack: 20, isConnected: true }; // exactly BB
      const hand = createHand(club, 0);
      startHand(hand);

      expect(hand.players[2].isAllIn).toBe(true);

      const aliceSeat = hand.players[0].seatIndex;
      const bobSeat = hand.players[1].seatIndex;

      // Alice shoves all-in
      const r1 = handleAction(hand, aliceSeat, 'raise', 100);
      expect(r1.error).toBeNull();
      // Turn goes to Bob — never to the all-in BB
      expect(hand.players[hand.currentPlayerIndex].seatIndex).toBe(bobSeat);

      // Bob calls all-in → everyone is all-in → one street is dealt; the
      // orchestrator then runs out the rest one street at a time.
      const r2 = handleAction(hand, bobSeat, 'raise', 100);
      expect(r2.error).toBeNull();
      expect(hand.gameStatus).toBe(GAME_STATES.FLOP);
      expect(hand.communityCards.length).toBe(3);

      let streetGuard = 0;
      while (!isHandComplete(hand) && streetGuard < 6) {
        streetGuard++;
        advanceCompleteRoundStep(hand);
      }
      expect(hand.gameStatus).toBe(GAME_STATES.HAND_COMPLETE);
      expect(hand.communityCards.length).toBe(5);
      expect(hand.handResult).toBeDefined();
    });

    test('all-in BB is skipped on later streets; only live players act', () => {
      const club = createClubState();
      club.seats[2] = { userId: 'u3', userName: 'Charlie', stack: 20, isConnected: true }; // exactly BB
      const hand = createHand(club, 0);
      startHand(hand);

      expect(hand.players[2].isAllIn).toBe(true);

      // Alice and Bob call the 20 blind → round completes → flop
      handleAction(hand, hand.players[hand.currentPlayerIndex].seatIndex, 'call');
      handleAction(hand, hand.players[hand.currentPlayerIndex].seatIndex, 'call');
      expect(hand.gameStatus).toBe(GAME_STATES.FLOP);

      // Everyone still live checks every street; the all-in BB is never the
      // current player, and the hand runs all the way to showdown.
      const bbSeat = hand.players[2].seatIndex;
      let guard = 0;
      while (hand.gameStatus !== GAME_STATES.SHOWDOWN && hand.gameStatus !== GAME_STATES.HAND_COMPLETE && guard < 12) {
        guard++;
        const cur = hand.players[hand.currentPlayerIndex];
        expect(cur.seatIndex).not.toBe(bbSeat);
        const r = handleAction(hand, cur.seatIndex, 'check');
        expect(r.error).toBeNull();
      }
      // Everyone checked down — the two live players decide at the showdown
      completeShowdown(hand);
      expect(hand.communityCards.length).toBe(5);
      expect(hand.gameStatus).toBe(GAME_STATES.HAND_COMPLETE);
    });

    test('heads-up where both blinds are all-in runs out via advanceCompleteRounds', () => {
      const club = createClubState();
      club.seats[2] = null; // heads-up
      club.seats[0] = { userId: 'u1', userName: 'Alice', stack: 20, isConnected: true }; // dealer/BB
      club.seats[1] = { userId: 'u2', userName: 'Bob', stack: 10, isConnected: true };   // SB
      const hand = createHand(club, 0);
      startHand(hand);

      expect(hand.players[0].isAllIn).toBe(true);
      expect(hand.players[1].isAllIn).toBe(true);

      advanceCompleteRounds(hand);
      expect(hand.gameStatus).toBe(GAME_STATES.HAND_COMPLETE);
      expect(hand.communityCards.length).toBe(5);
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
