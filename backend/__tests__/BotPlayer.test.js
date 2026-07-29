const { getHandStrength, decideAction, getNextBotName, resetBotNames } = require('../botPlayer');

describe('BotPlayer', () => {
  describe('getNextBotName', () => {
    it('returns bot names from the pool', () => {
      resetBotNames();
      const name1 = getNextBotName();
      expect(name1).toContain('Bot');
      const name2 = getNextBotName();
      expect(name2).toContain('Bot');
      expect(name2).not.toBe(name1);
    });

    it('rotates through names', () => {
      resetBotNames();
      const names = [];
      for (let i = 0; i < 6; i++) {
        names.push(getNextBotName());
      }
      // Should have wrapped around
      expect(names[0]).toBe(names[5]);
    });
  });

  describe('getHandStrength', () => {
    it('returns high strength for pocket aces pre-flop', () => {
      const strength = getHandStrength([
        { rank: 14, suit: 'hearts' },
        { rank: 14, suit: 'clubs' },
      ], []);
      expect(strength).toBeGreaterThan(0.7);
    });

    it('returns medium strength for AK suited pre-flop', () => {
      const strength = getHandStrength([
        { rank: 14, suit: 'hearts' },
        { rank: 13, suit: 'hearts' },
      ], []);
      expect(strength).toBeGreaterThan(0.5);
      expect(strength).toBeLessThanOrEqual(1);
    });

    it('returns low strength for 72 offsuit pre-flop', () => {
      const strength = getHandStrength([
        { rank: 7, suit: 'hearts' },
        { rank: 2, suit: 'clubs' },
      ], []);
      expect(strength).toBeLessThan(0.4);
    });

    it('uses community cards when available', () => {
      const strength = getHandStrength([
        { rank: 14, suit: 'hearts' },
        { rank: 14, suit: 'clubs' },
      ], [
        { rank: 14, suit: 'diamonds', suitSymbol: '♦' },
        { rank: 3, suit: 'spades', suitSymbol: '♠' },
        { rank: 9, suit: 'clubs', suitSymbol: '♣' },
      ]);
      expect(strength).toBeGreaterThan(0);
      expect(strength).toBeLessThanOrEqual(1);
    });
  });

  describe('decideAction', () => {
    function makeMockHand(opts = {}) {
      return {
        players: [
          {
            seatIndex: 0,
            userName: 'Test',
            holeCards: opts.holeCards || [
              { rank: 14, suit: 'hearts', suitSymbol: '♥' },
              { rank: 14, suit: 'clubs', suitSymbol: '♣' },
            ],
            stack: opts.stack || 1500,
            roundBet: opts.roundBet || 0,
            betAmount: opts.betAmount || 0,
            isFolded: false,
            isAllIn: false,
          },
        ],
        communityCards: opts.communityCards || [],
        currentBet: opts.currentBet || 0,
        pot: opts.pot || 0,
        bigBlind: opts.bigBlind || 20,
        smallBlind: 10,
      };
    }

    it('returns check when no bet and weak hand', () => {
      const hand = makeMockHand({
        holeCards: [
          { rank: 2, suit: 'hearts', suitSymbol: '♥' },
          { rank: 7, suit: 'clubs', suitSymbol: '♣' },
        ],
        currentBet: 0,
      });
      const decision = decideAction(hand, 0);
      expect(decision.action).toBe('check');
    });

    it('returns call when there is a bet', () => {
      const hand = makeMockHand({
        holeCards: [
          { rank: 14, suit: 'hearts', suitSymbol: '♥' },
          { rank: 13, suit: 'clubs', suitSymbol: '♣' },
        ],
        currentBet: 40,
        roundBet: 0,
        pot: 60,
      });
      const decision = decideAction(hand, 0);
      // With AK and a reasonable call, should call
      expect(['call', 'raise']).toContain(decision.action);
    });

    it('may fold with very weak hand and large bet', () => {
      const hand = makeMockHand({
        holeCards: [
          { rank: 2, suit: 'hearts', suitSymbol: '♥' },
          { rank: 7, suit: 'clubs', suitSymbol: '♣' },
        ],
        currentBet: 200,
        roundBet: 0,
        pot: 300,
        bigBlind: 20,
      });
      const decision = decideAction(hand, 0);
      // With 72 offsuit and a big bet, may fold
      expect(['fold', 'call']).toContain(decision.action);
    });

    it('returns a valid action type', () => {
      const hand = makeMockHand({});
      const decision = decideAction(hand, 0);
      expect(['fold', 'check', 'call', 'raise', 'bet']).toContain(decision.action);
    });

    it('always returns an object with action property', () => {
      const hand = makeMockHand({
        holeCards: [
          { rank: 3, suit: 'hearts', suitSymbol: '♥' },
          { rank: 5, suit: 'clubs', suitSymbol: '♣' },
        ],
      });
      const decision = decideAction(hand, 0);
      expect(decision).toHaveProperty('action');
    });
  });
});
