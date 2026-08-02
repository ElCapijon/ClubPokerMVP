const { createHand, startHand, goToShowdown, handleAction, applyShowdownDecision } = require('../GameHand');

/** Resolve the interactive showdown reveal phase (everyone shows). */
function completeShowdown(hand) {
  let guard = 0;
  while (hand.gameStatus === 'SHOWDOWN' && guard < 10) {
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
      { userId: 'u1', userName: 'Alice', stack: 1500, isConnected: true, isSittingOut: false },
      { userId: 'u2', userName: 'Bob', stack: 1500, isConnected: true, isSittingOut: false },
      { userId: 'u3', userName: 'Charlie', stack: 1500, isConnected: true, isSittingOut: false },
      null, null, null,
    ],
    hostId: 'u1',
    tableSettings: { sb: 10, bb: 20, startingStack: 1500, timer: 20, allowRebuys: true },
  };
}

function cc(rank, suit) {
  const values = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, J: 11, Q: 12, K: 13, A: 14 };
  const suitSymbols = { h: '♥', d: '♦', c: '♣', s: '♠' };
  const suitFull = { h: 'hearts', d: 'diamonds', c: 'clubs', s: 'spades' };
  return {
    rankName: rank,
    suit: suitFull[suit],
    value: values[rank],
    suitSymbol: suitSymbols[suit],
    key: `${rank}${suit.toUpperCase()}`,
  };
}

describe('Phase 5 - Showdown & Side Pots', () => {
  describe('Rebuy system', () => {
    test('createHand skips players with 0 stack', () => {
      const club = createClubState();
      club.seats[0].stack = 0; // Alice busted
      
      const hand = createHand(club, 0);
      expect(hand).not.toBeNull();
      expect(hand.players.length).toBe(2); // Only Bob and Charlie
      expect(hand.players.find(p => p.userName === 'Alice')).toBeUndefined();
    });

    test('createHand includes rebought players', () => {
      const club = createClubState();
      club.seats[0].stack = 0; // Alice busted
      
      // After rebuy, stack is reset
      club.seats[0].stack = 1500;
      
      const hand = createHand(club, 1);
      expect(hand.players.length).toBe(3);
      expect(hand.players.find(p => p.userName === 'Alice')).toBeDefined();
    });

    test('createHand skips players sitting out', () => {
      const club = createClubState();
      club.seats[0].isSittingOut = true;
      
      const hand = createHand(club, 0);
      expect(hand.players.length).toBe(2);
    });
  });

  describe('Side pot accuracy', () => {
    test('three players with different all-in amounts create correct side pots', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);
      
      // Set up specific hole cards so we can determine winners
      const aliceSeat = hand.players[0].seatIndex;
      const bobSeat = hand.players[1].seatIndex;
      const charlieSeat = hand.players[2].seatIndex;
      
      hand.players[0].holeCards = [cc('A', 'h'), cc('K', 'h')]; // Alice: AK (pair of K's on board)
      hand.players[1].holeCards = [cc('2', 'd'), cc('7', 'd')]; // Bob: 27 (nothing)
      hand.players[2].holeCards = [cc('3', 'c'), cc('8', 's')]; // Charlie: 38 (nothing)
      
      // Community: K high, no flush or straight
      hand.communityCards = [
        cc('5', 'c'), cc('6', 'd'), cc('9', 's'),
        cc('10', 'c'), cc('K', 'd'),
      ];
      
      // Set up specific bet amounts to test side pots
      for (const p of hand.players) {
        p.isAllIn = true;
        p.hasActed = true;
        p.isFolded = false;
      }
      hand.players[0].betAmount = 100;
      hand.players[0].stack = 0;
      hand.players[1].betAmount = 300;
      hand.players[1].stack = 0;
      hand.players[2].betAmount = 500;
      hand.players[2].stack = 1000;
      hand.pot = 900;
      
      goToShowdown(hand);
      
      expect(hand.gameStatus).toBe('HAND_COMPLETE');
      expect(hand.handResult).toBeDefined();
      
      // Should have 3 pots (levels 100, 300, 500)
      expect(hand.handResult.length).toBe(3);
      
      const pot100 = hand.handResult.find(r => r.level === 100);
      const pot300 = hand.handResult.find(r => r.level === 300);
      const pot500 = hand.handResult.find(r => r.level === 500);
      
      expect(pot100).toBeDefined();
      expect(pot300).toBeDefined();
      expect(pot500).toBeDefined();
      
      // Pot 100 (100 x 3 = 300): all three eligible, Alice wins (pair of K's)
      expect(pot100.potAmount).toBe(300);
      const w100Winner = pot100.winners.find(w => w.seatIndex === aliceSeat);
      expect(w100Winner).toBeDefined();
      expect(w100Winner.amountWon).toBe(300);
      
      // Pot 300 (200 x 2 = 400): Bob and Charlie eligible, Alice can't win this
      expect(pot300.potAmount).toBe(400);
      const w300Alice = pot300.winners.find(w => w.seatIndex === aliceSeat);
      expect(w300Alice).toBeUndefined(); // Alice not eligible for this pot
      
      // Bob and Charlie both have nothing, so Bob wins (K vs 10 kicker... no wait)
      // Actually both have no pair, Bob has K-10-9-7-2 (K-high), Charlie has K-10-9-8-5 (K-high)
      // Charlie's 8 > Bob's 7, so Charlie should win the side pot
      const w300Charlie = pot300.winners.find(w => w.seatIndex === charlieSeat);
      expect(w300Charlie).toBeDefined();
    });

    test('folded player chips are awarded (not destroyed) after a call-then-fold showdown', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);

      // Deterministic hole cards so the outcome doesn't depend on the random board
      hand.players[0].holeCards = [cc('A', 'h'), cc('K', 'h')]; // Alice: best hand
      hand.players[1].holeCards = [cc('2', 'd'), cc('7', 'd')];
      hand.players[2].holeCards = [cc('3', 'c'), cc('8', 's')];

      const aliceSeat = hand.players[0].seatIndex;
      const bobSeat = hand.players[1].seatIndex;
      const charlieSeat = hand.players[2].seatIndex;

      // Preflop: everyone calls → Alice 20, Bob 20, Charlie 20 (pot 60)
      handleAction(hand, hand.players[hand.currentPlayerIndex].seatIndex, 'call');
      handleAction(hand, hand.players[hand.currentPlayerIndex].seatIndex, 'call');
      handleAction(hand, hand.players[hand.currentPlayerIndex].seatIndex, 'call');
      expect(hand.gameStatus).toBe('FLOP');
      expect(hand.pot).toBe(60);

      // Flop: Bob (SB, first to act post-flop) bets 200, Charlie folds (his 20
      // stays in the pot), Alice calls 200 → pot = 60 + 200 + 200 = 460
      handleAction(hand, bobSeat, 'bet', 200);
      handleAction(hand, charlieSeat, 'fold');
      handleAction(hand, aliceSeat, 'call');
      expect(hand.gameStatus).toBe('TURN');
      expect(hand.pot).toBe(460);

      // Turn: Bob check, Alice check → river. River: Bob check, Alice check → showdown
      handleAction(hand, bobSeat, 'check');
      handleAction(hand, aliceSeat, 'check');
      handleAction(hand, bobSeat, 'check');
      handleAction(hand, aliceSeat, 'check');

      // Reveal phase: both live players decide (they show) → hand completes
      expect(hand.gameStatus).toBe('SHOWDOWN');
      completeShowdown(hand);
      expect(hand.gameStatus).toBe('HAND_COMPLETE');
      expect(hand.handResult).toBeDefined();

      // The full pot (including Charlie's folded 20) must be awarded — no chips
      // may be destroyed. Old buggy behavior awarded only 440 here.
      const totalAwarded = hand.handResult.reduce((sum, r) => sum + r.potAmount, 0);
      expect(totalAwarded).toBe(460);

      // Charlie folded and must not appear as a winner anywhere
      const foldedWins = hand.handResult.some(r =>
        r.winners.some(w => w.seatIndex === charlieSeat)
      );
      expect(foldedWins).toBe(false);

      // Charlie's stack stays exactly where it was when he folded (20 committed)
      const charlie = hand.players.find(p => p.seatIndex === charlieSeat);
      expect(charlie.stack).toBe(1500 - 20);
    });
  });

  describe('Full hand with showdown', () => {
    test('hand completes with correct pot distribution after showdown', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);
      
      // All players call preflop
      for (let i = 0; i < 3; i++) {
        const seatIdx = hand.players[hand.currentPlayerIndex].seatIndex;
        handleAction(hand, seatIdx, 'call');
      }
      
      // All check flop
      for (let i = 0; i < 3; i++) {
        const seatIdx = hand.players[hand.currentPlayerIndex].seatIndex;
        handleAction(hand, seatIdx, 'check');
      }
      
      // All check turn
      for (let i = 0; i < 3; i++) {
        const seatIdx = hand.players[hand.currentPlayerIndex].seatIndex;
        handleAction(hand, seatIdx, 'check');
      }
      
      // All check river (this will trigger the interactive showdown)
      for (let i = 0; i < 3; i++) {
        const seatIdx = hand.players[hand.currentPlayerIndex].seatIndex;
        handleAction(hand, seatIdx, 'check');
      }

      // Reveal phase: all three players show → hand completes
      expect(hand.gameStatus).toBe('SHOWDOWN');
      completeShowdown(hand);

      // Hand should be complete at showdown
      expect(hand.gameStatus).toBe('HAND_COMPLETE');
      expect(hand.handResult).toBeDefined();
      expect(hand.handResult.length).toBeGreaterThanOrEqual(1);
      
      // Pot starts at 30 (10 SB + 20 BB)
      // Alice calls: +20 = 50
      // Bob calls: +10 (had 10 as SB) = 60
      // Charlie checks: +0 (had 20 as BB, already matched)
      // Total: 60
      expect(hand.pot).toBe(60);
    });

    test('winner gets the pot', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);
      
      // Fold two players - last one wins uncontested
      for (let i = 0; i < 2; i++) {
        const seatIdx = hand.players[hand.currentPlayerIndex].seatIndex;
        handleAction(hand, seatIdx, 'fold');
      }
      
      // Only one player left - hand should be complete
      expect(hand.gameStatus).toBe('HAND_COMPLETE');
      expect(hand.handResult.length).toBe(1);
      
      // The last player standing wins the pot
      const winner = hand.handResult[0].winners[0];
      expect(winner.amountWon).toBe(hand.pot);
      expect(winner.handResult.rankName).toBe('Uncontested');
    });
  });
});
