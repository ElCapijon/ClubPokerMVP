const { createDeck, shuffle, dealCards, cardToString, SUITS } = require('../Deck');

describe('Deck', () => {
  describe('createDeck', () => {
    test('creates a deck of 52 unique cards', () => {
      const deck = createDeck();
      expect(deck.length).toBe(52);
      
      const keys = new Set(deck.map(c => c.key));
      expect(keys.size).toBe(52);
    });

    test('cards have correct structure', () => {
      const deck = createDeck();
      const card = deck[0];
      
      expect(card).toHaveProperty('suit');
      expect(card).toHaveProperty('suitSymbol');
      expect(card).toHaveProperty('rankName');
      expect(card).toHaveProperty('value');
      expect(card).toHaveProperty('key');
    });

    test('contains 4 suits with 13 cards each', () => {
      const deck = createDeck();
      
      for (const suit of SUITS) {
        const suited = deck.filter(c => c.suit === suit);
        expect(suited.length).toBe(13);
      }
    });

    test('contains all ranks 2-14', () => {
      const deck = createDeck();
      const values = new Set(deck.map(c => c.value));
      
      for (let v = 2; v <= 14; v++) {
        expect(values.has(v)).toBe(true);
      }
    });

    test('has correct number of each rank across suits', () => {
      const deck = createDeck();
      
      for (let v = 2; v <= 14; v++) {
        const cardsOfValue = deck.filter(c => c.value === v);
        expect(cardsOfValue.length).toBe(4);
      }
    });
  });

  describe('shuffle', () => {
    test('returns a new array (does not mutate input)', () => {
      const deck = createDeck();
      const shuffled = shuffle(deck);
      
      expect(shuffled).not.toBe(deck);
      expect(Array.isArray(shuffled)).toBe(true);
    });

    test('contains all 52 cards', () => {
      const deck = createDeck();
      const shuffled = shuffle(deck);
      
      expect(shuffled.length).toBe(52);
      
      const originalKeys = new Set(deck.map(c => c.key));
      const shuffledKeys = new Set(shuffled.map(c => c.key));
      
      expect(shuffledKeys).toEqual(originalKeys);
    });

    test('usually produces a different order', () => {
      const deck = createDeck();
      
      // Run shuffle 5 times, at least 4 should be different from original
      let sameCount = 0;
      for (let i = 0; i < 5; i++) {
        const shuffled = shuffle(deck);
        const isSame = shuffled.every((c, j) => c.key === deck[j].key);
        if (isSame) sameCount++;
      }
      
      expect(sameCount).toBeLessThan(3); // At least 3/5 should differ
    });
  });

  describe('dealCards', () => {
    test('deals correct number of players', () => {
      const deck = createDeck();
      const result = dealCards(deck, 6);
      
      expect(result.players.length).toBe(6);
      expect(result.players[0].length).toBe(2); // 2 hole cards each
    });

    test('deals 5 community cards', () => {
      const deck = createDeck();
      const result = dealCards(deck, 6);
      
      expect(result.community.length).toBe(5);
    });

    test('deals 3 burns', () => {
      const deck = createDeck();
      const result = dealCards(deck, 6);
      
      expect(result.burns.length).toBe(3);
    });

    test('all dealt cards are unique (no duplicates)', () => {
      const deck = createDeck();
      const result = dealCards(deck, 6);
      
      const allDealt = [
        ...result.players.flat(),
        ...result.community,
        ...result.burns,
      ];
      
      const keys = new Set(allDealt.map(c => c.key));
      expect(keys.size).toBe(allDealt.length);
    });

    test('remaining deck has correct number of cards', () => {
      const deck = createDeck();
      const result = dealCards(deck, 6);
      
      // 52 - (6*2 + 5 + 3) = 52 - 20 = 32
      expect(result.deck.length).toBe(32);
    });

    test('throws error for invalid number of players', () => {
      const deck = createDeck();
      
      expect(() => dealCards(deck, 0)).toThrow();
      expect(() => dealCards(deck, 11)).toThrow();
    });

    test('throws error when not enough cards', () => {
      const deck = createDeck().slice(0, 10);
      
      expect(() => dealCards(deck, 6)).toThrow();
    });

    test('deals hole cards to 2 players', () => {
      const deck = createDeck();
      const result = dealCards(deck, 2);
      
      expect(result.players.length).toBe(2);
      expect(result.players[0].length).toBe(2);
      expect(result.players[1].length).toBe(2);
    });
  });

  describe('cardToString', () => {
    test('formats a card correctly', () => {
      const card = { rankName: 'A', suit: 'spades', suitSymbol: '♠', value: 14, key: 'AS' };
      expect(cardToString(card)).toBe('A♠');
    });
  });
});
