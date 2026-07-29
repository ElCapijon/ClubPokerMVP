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
  });
});
