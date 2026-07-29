const {
  evaluateHand,
  evaluate5Cards,
  compareHands,
  rankHands,
  HAND_RANKS,
} = require('../HandEvaluator');

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

// Helper: create a community board
function community(...cards) {
  return cards.map(([rank, suit]) => c(rank, suit));
}

// Helper: create hole cards
function hole(rank1, suit1, rank2, suit2) {
  return [c(rank1, suit1), c(rank2, suit2)];
}

describe('HandEvaluator', () => {
  // ==========================================
  // evaluate5Cards tests
  // ==========================================
  describe('evaluate5Cards', () => {
    test('detects High Card', () => {
      const cards = [c('2', 'hearts'), c('5', 'clubs'), c('9', 'diamonds'), c('J', 'spades'), c('K', 'hearts')];
      const result = evaluate5Cards(cards);
      expect(result.rank).toBe(HAND_RANKS.HIGH_CARD);
      expect(result.rankName).toBe('High Card');
    });

    test('detects One Pair', () => {
      const cards = [c('A', 'hearts'), c('A', 'clubs'), c('3', 'diamonds'), c('7', 'spades'), c('9', 'hearts')];
      const result = evaluate5Cards(cards);
      expect(result.rank).toBe(HAND_RANKS.ONE_PAIR);
      expect(result.rankName).toBe('One Pair');
    });

    test('detects Two Pair', () => {
      const cards = [c('K', 'hearts'), c('K', 'clubs'), c('Q', 'diamonds'), c('Q', 'spades'), c('3', 'hearts')];
      const result = evaluate5Cards(cards);
      expect(result.rank).toBe(HAND_RANKS.TWO_PAIR);
      expect(result.rankName).toBe('Two Pair');
    });

    test('detects Three of a Kind', () => {
      const cards = [c('7', 'hearts'), c('7', 'clubs'), c('7', 'diamonds'), c('K', 'spades'), c('2', 'hearts')];
      const result = evaluate5Cards(cards);
      expect(result.rank).toBe(HAND_RANKS.THREE_OF_A_KIND);
      expect(result.rankName).toBe('Three of a Kind');
    });

    test('detects Straight (normal)', () => {
      const cards = [c('9', 'hearts'), c('10', 'clubs'), c('J', 'diamonds'), c('Q', 'spades'), c('K', 'hearts')];
      const result = evaluate5Cards(cards);
      expect(result.rank).toBe(HAND_RANKS.STRAIGHT);
      expect(result.rankName).toBe('Straight');
    });

    test('detects Straight (wheel: A-2-3-4-5)', () => {
      const cards = [c('A', 'hearts'), c('2', 'clubs'), c('3', 'diamonds'), c('4', 'spades'), c('5', 'hearts')];
      const result = evaluate5Cards(cards);
      expect(result.rank).toBe(HAND_RANKS.STRAIGHT);
      expect(result.rankName).toBe('Straight');
      // 5-high straight
      expect(result.kickers[0]).toBe(5);
    });

    test('detects Flush', () => {
      const cards = [c('2', 'hearts'), c('5', 'hearts'), c('9', 'hearts'), c('J', 'hearts'), c('A', 'hearts')];
      const result = evaluate5Cards(cards);
      expect(result.rank).toBe(HAND_RANKS.FLUSH);
      expect(result.rankName).toBe('Flush');
    });

    test('detects Full House', () => {
      const cards = [c('K', 'hearts'), c('K', 'clubs'), c('K', 'diamonds'), c('Q', 'spades'), c('Q', 'hearts')];
      const result = evaluate5Cards(cards);
      expect(result.rank).toBe(HAND_RANKS.FULL_HOUSE);
      expect(result.rankName).toBe('Full House');
    });

    test('detects Four of a Kind', () => {
      const cards = [c('10', 'hearts'), c('10', 'clubs'), c('10', 'diamonds'), c('10', 'spades'), c('K', 'hearts')];
      const result = evaluate5Cards(cards);
      expect(result.rank).toBe(HAND_RANKS.FOUR_OF_A_KIND);
      expect(result.rankName).toBe('Four of a Kind');
    });

    test('detects Straight Flush', () => {
      const cards = [c('6', 'clubs'), c('7', 'clubs'), c('8', 'clubs'), c('9', 'clubs'), c('10', 'clubs')];
      const result = evaluate5Cards(cards);
      expect(result.rank).toBe(HAND_RANKS.STRAIGHT_FLUSH);
      expect(result.rankName).toBe('Straight Flush');
    });

    test('detects Royal Flush (Ace-high Straight Flush)', () => {
      const cards = [c('10', 'spades'), c('J', 'spades'), c('Q', 'spades'), c('K', 'spades'), c('A', 'spades')];
      const result = evaluate5Cards(cards);
      expect(result.rank).toBe(HAND_RANKS.STRAIGHT_FLUSH);
      expect(result.rankName).toBe('Straight Flush');
      expect(result.kickers[0]).toBe(14);
    });

    test('returns null for less than 5 cards', () => {
      expect(evaluate5Cards([c('A', 'hearts'), c('K', 'hearts'), c('Q', 'hearts')])).toBeNull();
    });
  });

  // ==========================================
  // Hand priority tests (higher rank beats lower)
  // ==========================================
  describe('hand ranking priority', () => {
    test('flush beats straight', () => {
      const flush = {
        rank: HAND_RANKS.FLUSH,
        rankName: 'Flush',
        kickers: [14, 10, 9, 5, 2],
      };
      const straight = {
        rank: HAND_RANKS.STRAIGHT,
        rankName: 'Straight',
        kickers: [10],
      };

      expect(compareHands(flush, straight)).toBeGreaterThan(0);
    });

    test('full house beats flush', () => {
      const fh = {
        rank: HAND_RANKS.FULL_HOUSE,
        rankName: 'Full House',
        kickers: [10, 5],
      };
      const flush = {
        rank: HAND_RANKS.FLUSH,
        rankName: 'Flush',
        kickers: [14, 10, 9, 5, 2],
      };

      expect(compareHands(fh, flush)).toBeGreaterThan(0);
    });

    test('straight flush beats four of a kind', () => {
      const sf = {
        rank: HAND_RANKS.STRAIGHT_FLUSH,
        rankName: 'Straight Flush',
        kickers: [9],
      };
      const quads = {
        rank: HAND_RANKS.FOUR_OF_A_KIND,
        rankName: 'Four of a Kind',
        kickers: [14, 10],
      };

      expect(compareHands(sf, quads)).toBeGreaterThan(0);
    });
  });

  // ==========================================
  // Kicker comparison tests
  // ==========================================
  describe('kicker comparison', () => {
    test('higher pair beats lower pair', () => {
      const pairAces = {
        rank: HAND_RANKS.ONE_PAIR,
        rankName: 'One Pair',
        kickers: [14, 13, 12, 11],
      };
      const pairKings = {
        rank: HAND_RANKS.ONE_PAIR,
        rankName: 'One Pair',
        kickers: [13, 14, 12, 11],
      };

      expect(compareHands(pairAces, pairKings)).toBeGreaterThan(0);
    });

    test('same pair goes to highest kicker', () => {
      const pairAcesKing = {
        rank: HAND_RANKS.ONE_PAIR,
        rankName: 'One Pair',
        kickers: [14, 13, 12, 11],
      };
      const pairAcesQueen = {
        rank: HAND_RANKS.ONE_PAIR,
        rankName: 'One Pair',
        kickers: [14, 12, 11, 10],
      };

      expect(compareHands(pairAcesKing, pairAcesQueen)).toBeGreaterThan(0);
    });

    test('two pair: higher top pair wins', () => {
      const tpAK = {
        rank: HAND_RANKS.TWO_PAIR,
        rankName: 'Two Pair',
        kickers: [14, 13, 11],
      };
      const tpKQ = {
        rank: HAND_RANKS.TWO_PAIR,
        rankName: 'Two Pair',
        kickers: [13, 12, 14],
      };

      expect(compareHands(tpAK, tpKQ)).toBeGreaterThan(0);
    });

    test('full house: higher trips wins', () => {
      const fhA = {
        rank: HAND_RANKS.FULL_HOUSE,
        rankName: 'Full House',
        kickers: [14, 13],
      };
      const fhK = {
        rank: HAND_RANKS.FULL_HOUSE,
        rankName: 'Full House',
        kickers: [13, 14],
      };

      expect(compareHands(fhA, fhK)).toBeGreaterThan(0);
    });

    test('exact tie returns 0', () => {
      const hand1 = {
        rank: HAND_RANKS.ONE_PAIR,
        rankName: 'One Pair',
        kickers: [14, 13, 12, 11],
      };
      const hand2 = {
        rank: HAND_RANKS.ONE_PAIR,
        rankName: 'One Pair',
        kickers: [14, 13, 12, 11],
      };

      expect(compareHands(hand1, hand2)).toBe(0);
    });
  });

  // ==========================================
  // evaluateHand (from 7 cards) tests
  // ==========================================
  describe('evaluateHand (7 cards)', () => {
    test('finds flush from 7 cards when only 5 are flush', () => {
      const hand = hole('A', 'hearts', 'K', 'hearts');
      const board = community(
        ['2', 'hearts'], ['7', 'hearts'], ['9', 'hearts'],
        ['J', 'diamonds'], ['Q', 'spades']
      );
      // 3 hearts in board + 2 in hand = 5 total = flush
      const result = evaluateHand(hand, board);
      expect(result.rank).toBe(HAND_RANKS.FLUSH);
    });

    test('finds straight on the board', () => {
      const hand = hole('2', 'hearts', '7', 'clubs');
      const board = community(
        ['10', 'hearts'], ['J', 'clubs'], ['Q', 'diamonds'],
        ['K', 'spades'], ['A', 'hearts']
      );
      const result = evaluateHand(hand, board);
      expect(result.rank).toBe(HAND_RANKS.STRAIGHT);
    });

    test('finds full house using one hole card', () => {
      const hand = hole('A', 'hearts', 'K', 'clubs');
      const board = community(
        ['A', 'diamonds'], ['A', 'spades'], ['K', 'hearts'],
        ['5', 'clubs'], ['9', 'diamonds']
      );
      const result = evaluateHand(hand, board);
      expect(result.rank).toBe(HAND_RANKS.FULL_HOUSE);
    });

    test('selects best hand from 7 cards (straight flush over flush)', () => {
      const hand = hole('9', 'clubs', '10', 'clubs');
      const board = community(
        ['J', 'clubs'], ['Q', 'clubs'], ['K', 'clubs'],
        ['A', 'diamonds'], ['2', 'hearts']
      );
      const result = evaluateHand(hand, board);
      expect(result.rank).toBe(HAND_RANKS.STRAIGHT_FLUSH);
    });

    test('handles pocket pair making four of a kind', () => {
      const hand = hole('8', 'hearts', '8', 'clubs');
      const board = community(
        ['8', 'diamonds'], ['8', 'spades'], ['K', 'hearts'],
        ['2', 'clubs'], ['7', 'diamonds']
      );
      const result = evaluateHand(hand, board);
      expect(result.rank).toBe(HAND_RANKS.FOUR_OF_A_KIND);
    });

    test('returns null with fewer than 5 total cards', () => {
      expect(evaluateHand([c('A', 'hearts')], [c('K', 'hearts'), c('Q', 'hearts')])).toBeNull();
    });
  });

  // ==========================================
  // rankHands tests
  // ==========================================
  describe('rankHands', () => {
    test('sorts hands best first', () => {
      const highCard = { rank: HAND_RANKS.HIGH_CARD, rankName: 'High Card', kickers: [14, 13, 12, 11, 9] };
      const pair = { rank: HAND_RANKS.ONE_PAIR, rankName: 'One Pair', kickers: [14, 13, 12, 11] };
      
      const players = [
        { playerIndex: 0, handResult: highCard },
        { playerIndex: 1, handResult: pair },
      ];
      
      const ranked = rankHands(players);
      expect(ranked[0].playerIndex).toBe(1); // pair is better
      expect(ranked[0].rankPosition).toBe(1);
      expect(ranked[1].rankPosition).toBe(2);
    });

    test('handles ties correctly', () => {
      const pair1 = { rank: HAND_RANKS.ONE_PAIR, rankName: 'One Pair', kickers: [14, 13, 12, 11] };
      const pair2 = { rank: HAND_RANKS.ONE_PAIR, rankName: 'One Pair', kickers: [14, 13, 12, 11] };
      const highCard = { rank: HAND_RANKS.HIGH_CARD, rankName: 'High Card', kickers: [14, 13, 12, 11, 9] };
      
      const players = [
        { playerIndex: 0, handResult: pair1 },
        { playerIndex: 1, handResult: pair2 },
        { playerIndex: 2, handResult: highCard },
      ];
      
      const ranked = rankHands(players);
      expect(ranked[0].rankPosition).toBe(1); // tied for 1st
      expect(ranked[1].rankPosition).toBe(1); // tied for 1st
      expect(ranked[2].rankPosition).toBe(3); // 3rd place
    });
  });

  // ==========================================
  // Edge cases
  // ==========================================
  describe('edge cases', () => {
    test('A-2-3-4-5 straight (wheel) beats K-Q-J-10-9 high card', () => {
      const wheel = evaluate5Cards([
        c('A', 'hearts'), c('2', 'clubs'), c('3', 'diamonds'), c('4', 'spades'), c('5', 'hearts')
      ]);
      const highCard = evaluate5Cards([
        c('A', 'clubs'), c('K', 'hearts'), c('Q', 'diamonds'), c('J', 'spades'), c('9', 'hearts')
      ]);
      
      expect(compareHands(wheel, highCard)).toBeGreaterThan(0);
    });

    test('A-K-Q-J-10 straight (Broadway) beats K-Q-J-10-9 straight', () => {
      const broadway = evaluate5Cards([
        c('A', 'hearts'), c('K', 'clubs'), c('Q', 'diamonds'), c('J', 'spades'), c('10', 'hearts')
      ]);
      const kHigh = evaluate5Cards([
        c('K', 'hearts'), c('Q', 'clubs'), c('J', 'diamonds'), c('10', 'spades'), c('9', 'hearts')
      ]);
      
      expect(compareHands(broadway, kHigh)).toBeGreaterThan(0);
    });
  });
});
