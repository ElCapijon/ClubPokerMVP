const { calculateSidePots, determineWinners } = require('../PotSplitter');
const { evaluateHand } = require('../HandEvaluator');

// Helper: create a card quickly for tests
function c(rankName, suit) {
  const values = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, J: 11, Q: 12, K: 13, A: 14 };
  const suitSymbols = { hearts: '♥', diamonds: '♦', clubs: '♣', spades: '♠' };
  return {
    rankName,
    suit,
    value: values[rankName],
    suitSymbol: suitSymbols[suit],
    key: `${rankName}${suit[0].toUpperCase()}`,
  };
}

describe('PotSplitter', () => {
  describe('calculateSidePots', () => {
    test('no all-ins creates single pot', () => {
      const players = [
        { playerIndex: 0, stack: 1500, betAmount: 50, isAllIn: false },
        { playerIndex: 1, stack: 1500, betAmount: 50, isAllIn: false },
        { playerIndex: 2, stack: 1500, betAmount: 50, isAllIn: false },
      ];

      const pots = calculateSidePots(players);
      expect(pots.length).toBe(1);
      expect(pots[0].potAmount).toBe(150);
      expect(pots[0].eligiblePlayerIndices).toEqual([0, 1, 2]);
    });

    test('one all-in creates side pot', () => {
      const players = [
        { playerIndex: 0, stack: 500, betAmount: 500, isAllIn: true },
        { playerIndex: 1, stack: 1500, betAmount: 500, isAllIn: false },
        { playerIndex: 2, stack: 1500, betAmount: 500, isAllIn: false },
      ];

      const pots = calculateSidePots(players);
      // Main pot: 500*3 = 1500 (all contribute 500)
      expect(pots.length).toBe(1); // Only one level since they all bet the same
      expect(pots[0].potAmount).toBe(1500);
    });

    test('all-in with different bet amounts creates multiple side pots', () => {
      const players = [
        { playerIndex: 0, stack: 200, betAmount: 200, isAllIn: true },
        { playerIndex: 1, stack: 1500, betAmount: 500, isAllIn: false },
        { playerIndex: 2, stack: 1500, betAmount: 500, isAllIn: false },
      ];

      const pots = calculateSidePots(players);
      expect(pots.length).toBe(2);

      // First level (200 x 3 = 600) - all 3 contribute 200
      expect(pots[0].potAmount).toBe(600);
      expect(pots[0].eligiblePlayerIndices).toEqual([0, 1, 2]);

      // Second level (300 x 2 = 600) - only players 1 and 2 contribute remaining 300
      expect(pots[1].potAmount).toBe(600);
      expect(pots[1].eligiblePlayerIndices).toEqual([1, 2]);

      // Total: 600 + 600 = 1200 (200 + 500 + 500 = 1200 ✓)
    });

    test('multiple all-ins at different levels', () => {
      const players = [
        { playerIndex: 0, stack: 100, betAmount: 100, isAllIn: true },
        { playerIndex: 1, stack: 300, betAmount: 300, isAllIn: true },
        { playerIndex: 2, stack: 1500, betAmount: 500, isAllIn: false },
      ];

      const pots = calculateSidePots(players);
      expect(pots.length).toBe(3);

      // Level 1: 100 x 3 = 300 (all 3)
      expect(pots[0].potAmount).toBe(300);
      expect(pots[0].eligiblePlayerIndices).toEqual([0, 1, 2]);

      // Level 2: 200 x 2 = 400 (players 1 and 2)
      expect(pots[1].potAmount).toBe(400);
      expect(pots[1].eligiblePlayerIndices).toEqual([1, 2]);

      // Level 3: 200 x 1 = 200 (player 2 only)
      expect(pots[2].potAmount).toBe(200);
      expect(pots[2].eligiblePlayerIndices).toEqual([2]);

      // Total: 300 + 400 + 200 = 900 (100 + 300 + 500 = 900 ✓)
    });
  });

  describe('determineWinners', () => {
    test('single winner with best hand takes all', () => {
      const communityCards = [
        c('A', 'hearts'), c('K', 'clubs'), c('Q', 'diamonds'),
        c('J', 'spades'), c('9', 'hearts'),
      ];

      const players = [
        {
          playerIndex: 0,
          holeCards: [c('10', 'hearts'), c('2', 'clubs')], // Has straight (10-A)
          stack: 1500,
          betAmount: 100,
          isAllIn: false,
          isFolded: false,
        },
        {
          playerIndex: 1,
          holeCards: [c('2', 'diamonds'), c('7', 'spades')], // High card only
          stack: 1500,
          betAmount: 100,
          isAllIn: false,
          isFolded: false,
        },
      ];

      const results = determineWinners(players, communityCards);
      expect(results.length).toBe(1);
      expect(results[0].winners.length).toBe(1);
      expect(results[0].winners[0].playerIndex).toBe(0);
      expect(results[0].winners[0].amountWon).toBe(200);
    });

    test('folded player cannot win', () => {
      const communityCards = [
        c('A', 'hearts'), c('K', 'clubs'), c('Q', 'diamonds'),
        c('J', 'spades'), c('9', 'hearts'),
      ];

      const players = [
        {
          playerIndex: 0,
          holeCards: [c('10', 'hearts'), c('2', 'clubs')], // Has straight
          stack: 1500,
          betAmount: 100,
          isAllIn: false,
          isFolded: true, // Folded!
        },
        {
          playerIndex: 1,
          holeCards: [c('2', 'diamonds'), c('7', 'spades')], // High card
          stack: 1500,
          betAmount: 100,
          isAllIn: false,
          isFolded: false,
        },
      ];

      const results = determineWinners(players, communityCards);
      expect(results.length).toBe(1);
      expect(results[0].winners.length).toBe(1);
      expect(results[0].winners[0].playerIndex).toBe(1); // Player 1 wins despite worse hand
      // Player 0 folded, but their 100 chips are still in the pot — the winner
      // must receive the full 200, not just the 100 the active player matched.
      expect(results[0].winners[0].amountWon).toBe(200);
    });

    test('folded player chips stay in the pot (not destroyed)', () => {
      const community = [
        c('A', 'clubs'), c('K', 'spades'), c('Q', 'hearts'),
        c('2', 'diamonds'), c('3', 'hearts'),
      ];

      const players = [
        {
          playerIndex: 0,
          holeCards: [c('9', 'spades'), c('8', 'spades')], // High card — folded anyway
          stack: 1400,
          betAmount: 100,
          isAllIn: false,
          isFolded: true, // Called preflop, folded on the flop — chips stay in the pot
        },
        {
          playerIndex: 1,
          holeCards: [c('A', 'hearts'), c('K', 'hearts')], // Two pair (A & K)
          stack: 1200,
          betAmount: 300,
          isAllIn: false,
          isFolded: false,
        },
        {
          playerIndex: 2,
          holeCards: [c('A', 'diamonds'), c('K', 'diamonds')], // Same two pair — ties
          stack: 1200,
          betAmount: 300,
          isAllIn: false,
          isFolded: false,
        },
      ];

      const results = determineWinners(players, community);

      // Pot = 100 + 300 + 300 = 700. NOTHING may vanish.
      const totalAwarded = results.reduce((sum, r) => sum + r.potAmount, 0);
      expect(totalAwarded).toBe(700);

      // Level 100 main pot (100 x 3 = 300): all three eligible, P1 & P2 tie → 150 each
      const mainPot = results.find(r => r.level === 100);
      expect(mainPot.potAmount).toBe(300);
      expect(mainPot.winners.length).toBe(2);
      expect(mainPot.winners.reduce((s, w) => s + w.amountWon, 0)).toBe(300);

      // Level 300 side pot (200 x 2 = 400): P1 & P2 only, tie → 200 each
      const sidePot = results.find(r => r.level === 300);
      expect(sidePot.potAmount).toBe(400);
      expect(sidePot.winners.length).toBe(2);
      expect(sidePot.winners.reduce((s, w) => s + w.amountWon, 0)).toBe(400);
    });

    test('folded player betting more than everyone else: unmatched chips go to the best hand', () => {
      const community = [
        c('A', 'clubs'), c('K', 'spades'), c('Q', 'hearts'),
        c('2', 'diamonds'), c('3', 'hearts'),
      ];

      const players = [
        {
          playerIndex: 0,
          holeCards: [c('9', 'spades'), c('8', 'spades')],
          stack: 1000,
          betAmount: 500,
          isAllIn: false,
          isFolded: true, // Bet 500, folded when the short stacks shoved — 200 unmatched
        },
        {
          playerIndex: 1,
          holeCards: [c('A', 'hearts'), c('K', 'hearts')], // Best hand
          stack: 0,
          betAmount: 300,
          isAllIn: true,
          isFolded: false,
        },
        {
          playerIndex: 2,
          holeCards: [c('9', 'diamonds'), c('8', 'diamonds')],
          stack: 0,
          betAmount: 300,
          isAllIn: true,
          isFolded: false,
        },
      ];

      const results = determineWinners(players, community);

      // Pot = 500 + 300 + 300 = 1100. Nothing may vanish.
      const totalAwarded = results.reduce((sum, r) => sum + r.potAmount, 0);
      expect(totalAwarded).toBe(1100);

      // Main pot (300 x 3 = 900): eligible P0,P1,P2; best active hand is P1 → 900
      const mainPot = results.find(r => r.level === 300);
      expect(mainPot.potAmount).toBe(900);
      expect(mainPot.winners.length).toBe(1);
      expect(mainPot.winners[0].playerIndex).toBe(1);
      expect(mainPot.winners[0].amountWon).toBe(900);

      // Orphaned pot (level 500, 200 chips): its only contributor (P0) folded.
      // The chips can't vanish, so they're forfeited to the best active hand (P1).
      const orphanPot = results.find(r => r.level === 500);
      expect(orphanPot).toBeDefined();
      expect(orphanPot.potAmount).toBe(200);
      expect(orphanPot.winners.length).toBe(1);
      expect(orphanPot.winners[0].playerIndex).toBe(1);
      expect(orphanPot.winners[0].amountWon).toBe(200);
    });

    test('tie results in split pot', () => {
      const communityCards = [
        c('A', 'hearts'), c('K', 'clubs'), c('Q', 'diamonds'),
        c('2', 'spades'), c('7', 'hearts'),
      ];

      const players = [
        {
          playerIndex: 0,
          holeCards: [c('A', 'diamonds'), c('K', 'spades')], // Two pair (A & K)
          stack: 1500,
          betAmount: 100,
          isAllIn: false,
          isFolded: false,
        },
        {
          playerIndex: 1,
          holeCards: [c('A', 'clubs'), c('K', 'hearts')], // Same two pair
          stack: 1500,
          betAmount: 100,
          isAllIn: false,
          isFolded: false,
        },
      ];

      const results = determineWinners(players, communityCards);
      expect(results.length).toBe(1);
      expect(results[0].winners.length).toBe(2);

      // Split the pot (200 / 2 = 100 each)
      const totalWon = results[0].winners.reduce((sum, w) => sum + w.amountWon, 0);
      expect(totalWon).toBe(200);
    });

    test('side pot: all-in player can only win main pot', () => {
      const communityCards = [
        c('A', 'hearts'), c('K', 'clubs'), c('Q', 'diamonds'),
        c('J', 'spades'), c('9', 'hearts'),
      ];

      const players = [
        {
          playerIndex: 0,
          holeCards: [c('10', 'hearts'), c('2', 'clubs')], // Best hand (straight)
          stack: 1500,
          betAmount: 500,
          isAllIn: false,
          isFolded: false,
        },
        {
          playerIndex: 1,
          holeCards: [c('10', 'diamonds'), c('3', 'clubs')], // Also has straight (ties)
          stack: 300,
          betAmount: 300,
          isAllIn: true,
          isFolded: false,
        },
      ];

      const results = determineWinners(players, communityCards);

      // Player 0 and 1 both have the same straight
      // Pots:
      // - Level 1 (300 x 2 = 600): both eligible
      // - Level 2 (200 x 1 = 200): only player 0 eligible
      expect(results.length).toBe(2);

      // Main pot: split between both (300 each or 300+1 / 299)
      const mainPot = results.find(r => r.level === 300);
      expect(mainPot).toBeDefined();
      expect(mainPot.winners.length).toBe(2);

      // Side pot: only player 0 wins
      const sidePot = results.find(r => r.level > 300);
      expect(sidePot).toBeDefined();
      expect(sidePot.winners.length).toBe(1);
      expect(sidePot.winners[0].playerIndex).toBe(0);
    });

    // ============================================================
    // Tricky split-pot scenario: tie in main pot, different winner in side pot
    // ============================================================
    test('should split main pot between tied players and award side pot to the best hand', () => {
      // 3-way all-in: P1 (100 chips), P2 (300 chips), P3 (300 chips)
      // Main pot: 300 (100 x 3), eligible: [P1, P2, P3]
      // Side pot: 400 (200 x 2), eligible: [P2, P3]
      //
      // Hand evaluation:
      // Board: A♣ K♠ Q♥ 2♦ 3♣ — no pair on board
      // P1 (A♥ K♥): A,A,K,K,Q -> Two Pair (Aces & Kings) — TIED with P2
      // P2 (A♦ K♦): A,A,K,K,Q -> Two Pair (Aces & Kings) — TIED with P1
      // P3 (9♠ 8♠): A,K,Q,9,8 -> High Card (Ace-high) — loses to both
      //
      // Expected:
      //   Main pot (300): P1 and P2 each get 150 (split pot from tie)
      //   Side pot (400): P2 wins all 400 (P2 is best among eligible [P2,P3],
      //                   since P1 is not eligible for the side pot)
      //
      // This proves split-pot logic works alongside side-pot eligibility:
      // the main pot winners are different from the side pot winner distribution
      // (P1 wins 150 in main pot but 0 in side pot).
      const community = [
        c('A', 'clubs'), c('K', 'spades'), c('Q', 'hearts'),
        c('2', 'diamonds'), c('3', 'hearts'),
      ];

      const players = [
        {
          playerIndex: 0,
          holeCards: [c('A', 'hearts'), c('K', 'hearts')],
          stack: 0,
          betAmount: 100,
          isAllIn: true,
          isFolded: false,
        },
        {
          playerIndex: 1,
          holeCards: [c('A', 'diamonds'), c('K', 'diamonds')],
          stack: 0,
          betAmount: 300,
          isAllIn: true,
          isFolded: false,
        },
        {
          playerIndex: 2,
          holeCards: [c('9', 'spades'), c('8', 'spades')],
          stack: 0,
          betAmount: 300,
          isAllIn: true,
          isFolded: false,
        },
      ];

      const result = determineWinners(players, community);

      // Should be 2 pots:
      // Level 1 (100 x 3 = 300): Main pot — P1, P2, P3 all eligible
      // Level 2 (200 x 2 = 400): Side pot — P2 and P3 eligible
      expect(result.length).toBe(2);

      // ── Main pot: level 100, 300 chips, split between P1 and P2 (tied) ──
      const mainPot = result.find(r => r.level === 100);
      expect(mainPot).toBeDefined();
      expect(mainPot.potAmount).toBe(300);
      expect(mainPot.winners.length).toBe(2);

      // Both P1 and P2 should be winners of the main pot
      const mainWinnerIndices = mainPot.winners.map(w => w.playerIndex).sort();
      expect(mainWinnerIndices).toEqual([0, 1]);

      // Each should get exactly half (150 each)
      expect(mainPot.winners[0].amountWon).toBe(150);
      expect(mainPot.winners[1].amountWon).toBe(150);

      // P3 should NOT be a winner of the main pot (worse hand)
      expect(mainPot.winners.find(w => w.playerIndex === 2)).toBeUndefined();

      // ── Side pot: level 300, 400 chips, won entirely by P2 ──
      // P2 ties with P1, but P1 is not eligible for the side pot (only bet 100),
      // so P2 wins the side pot alone (best hand among eligible: P2, P3).
      // This demonstrates side pot eligibility creating a different winner distribution
      // than the main pot split.
      const sidePot = result.find(r => r.level === 300);
      expect(sidePot).toBeDefined();
      expect(sidePot.potAmount).toBe(400);
      expect(sidePot.winners.length).toBe(1);
      expect(sidePot.winners[0].playerIndex).toBe(1);
      expect(sidePot.winners[0].amountWon).toBe(400);
    });
  });
});
