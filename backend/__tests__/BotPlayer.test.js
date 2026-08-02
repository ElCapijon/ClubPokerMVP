const {
  isBotUserId,
  generateBotId,
  resetBotCounter,
  getBotName,
  evaluatePreFlopStrength,
  evaluateHandStrength,
  decideAction,
  decideShowdown,
  BOT_NAMES,
} = require('../BotPlayer');

describe('BotPlayer', () => {
  beforeEach(() => {
    resetBotCounter();
  });

  describe('isBotUserId', () => {
    test('recognizes bot_ prefixed ids', () => {
      expect(isBotUserId('bot_1234_1')).toBe(true);
    });

    test('rejects human ids', () => {
      expect(isBotUserId('9f8e7d6c-5b4a-4c3d-9e8f-1a2b3c4d5e6f')).toBe(false);
      expect(isBotUserId(undefined)).toBe(false);
      expect(isBotUserId('')).toBe(false);
    });
  });

  describe('generateBotId', () => {
    test('produces unique ids', () => {
      const ids = new Set();
      for (let i = 0; i < 20; i++) {
        ids.add(generateBotId());
      }
      expect(ids.size).toBe(20);
    });

    test('ids start with bot_', () => {
      expect(generateBotId().startsWith('bot_')).toBe(true);
    });
  });

  describe('getBotName', () => {
    test('returns unused names from the pool', () => {
      const name = getBotName(['Bot Alice', 'Bot Bob']);
      expect(BOT_NAMES).toContain(name);
      expect(['Bot Alice', 'Bot Bob']).not.toContain(name);
    });

    test('falls back to numbered name when the pool is exhausted', () => {
      resetBotCounter();
      generateBotId(); // bump counter
      const name = getBotName([...BOT_NAMES]);
      expect(name).toMatch(/^Bot #/);
    });
  });

  describe('evaluatePreFlopStrength', () => {
    const card = (value, suit = 's') => ({ value, suit });

    test('pocket aces are stronger than 7-2 offsuit', () => {
      const aces = evaluatePreFlopStrength([card(14), card(14)]);
      const sevenDeuce = evaluatePreFlopStrength([card(7), card(2)]);
      expect(aces).toBeGreaterThan(sevenDeuce);
      expect(aces).toBeGreaterThan(0.8);
    });

    test('suited connectors beat offsuit garbage', () => {
      const suitedConnector = evaluatePreFlopStrength([card(9, 'h'), card(10, 'h')]);
      const offsuitGarbage = evaluatePreFlopStrength([card(4, 'd'), card(9, 'c')]);
      expect(suitedConnector).toBeGreaterThan(offsuitGarbage);
    });

    test('always returns a value between 0 and 1', () => {
      for (let v1 = 2; v1 <= 14; v1++) {
        for (let v2 = 2; v2 <= 14; v2++) {
          const s = evaluatePreFlopStrength([card(v1), card(v2)]);
          expect(s).toBeGreaterThanOrEqual(0);
          expect(s).toBeLessThanOrEqual(1);
        }
      }
    });
  });

  describe('evaluateHandStrength', () => {
    const card = (value, suit = 's') => ({ value, suit });

    test('returns 0 without hole cards', () => {
      expect(evaluateHandStrength([], [], 0, 0, 100)).toBe(0);
    });

    test('pre-flop returns the heuristic', () => {
      const s = evaluateHandStrength([card(14), card(14)], [], 0, 0, 100);
      expect(s).toBeGreaterThan(0.8);
    });

    test('a made pair beats a high card on the flop', () => {
      const pair = evaluateHandStrength(
        [card(10, 'h'), card(10, 'd')],
        [card(2, 's'), card(7, 'c'), card(14, 'h')],
        100, 0, 500
      );
      const highCard = evaluateHandStrength(
        [card(14, 'h'), card(3, 'd')],
        [card(2, 's'), card(7, 'c'), card(9, 'h')],
        100, 0, 500
      );
      expect(pair).toBeGreaterThan(highCard);
    });
  });

  describe('decideAction', () => {
    const makeHand = (overrides = {}) => ({
      pot: 100,
      currentBet: 20,
      minRaise: 40,
      bigBlind: 20,
      communityCards: [],
      players: [
        { seatIndex: 0, holeCards: [{ value: 14, suit: 'h' }, { value: 14, suit: 'd' }], stack: 500, roundBet: 20, betAmount: 20 },
        { seatIndex: 1, holeCards: [{ value: 7, suit: 'h' }, { value: 2, suit: 'd' }], stack: 500, roundBet: 0, betAmount: 0 },
      ],
      ...overrides,
    });

    test('checks when there is nothing to call and the hand is weak', () => {
      // Player 1 already matched the 20 bet, so toCall = 0 → the check path
      const hand = makeHand({
        currentBet: 20,
        players: [
          { seatIndex: 0, holeCards: [{ value: 14, suit: 'h' }, { value: 14, suit: 'd' }], stack: 500, roundBet: 20, betAmount: 20 },
          { seatIndex: 1, holeCards: [{ value: 7, suit: 'h' }, { value: 2, suit: 'd' }], stack: 500, roundBet: 20, betAmount: 20 },
        ],
      });
      const decision = decideAction(hand, 1, {});
      expect(['check', 'bet']).toContain(decision.action);
    });

    test('folds weak hands to a large bet', () => {
      const hand = makeHand({ currentBet: 400, pot: 500 });
      // Player 1 has 7-2 offsuit and needs to call 400 into 500 — bad odds
      const decision = decideAction(hand, 1, {});
      expect(decision.action).toBe('fold');
    });

    test('calls with a strong hand', () => {
      const hand = makeHand({ currentBet: 100, pot: 300 });
      // Player 0 has pocket aces
      const decision = decideAction(hand, 0, {});
      expect(['call', 'raise']).toContain(decision.action);
    });

    test('always returns a valid action for a seated player', () => {
      const hand = makeHand({});
      for (const seat of [0, 1]) {
        const decision = decideAction(hand, seat, {});
        expect(['fold', 'check', 'call', 'raise', 'bet']).toContain(decision.action);
      }
    });
  });

  describe('decideShowdown', () => {
    const makeHand = () => ({ players: [{ seatIndex: 0 }, { seatIndex: 1 }] });

    test('always shows when mucking is not allowed (winning hand)', () => {
      expect(decideShowdown(makeHand(), 0, false)).toBe(true);
    });

    test('returns a boolean when mucking is allowed', () => {
      const result = decideShowdown(makeHand(), 1, true);
      expect(typeof result).toBe('boolean');
    });
  });
});
