// ChallengeTracker.test.js
//
// Regression tests for the "challenges keep repeating even after completion"
// bug. The completion toast is decided entirely from the in-memory cache, so
// if init() doesn't seed that cache from user_challenge_progress, a server
// restart leaves completed challenges looking fresh again.

const mockQuery = jest.fn();
jest.mock('../db', () => ({ query: (...args) => mockQuery(...args) }));

// Per-test DB fixtures (assigned in each test before calling init/trackStat)
let defs = [];
let seededProgressRows = [];
let userProgressRows = [];
let flushCalls = [];

let ChallengeTracker;

// ─── Test data helpers ───────────────────────────────────────
function handsWonDefs() {
  return [
    { id: 1, stat: 'handsWon', name: 'First Blood', description: 'Win your first hand', target_value: 1 },
    { id: 2, stat: 'handsWon', name: 'Double Digits', description: 'Win 10 hands', target_value: 10 },
  ];
}

function makeIo() {
  return { to: jest.fn().mockReturnValue({ emit: jest.fn() }) };
}

// Shared emit mock returned by io.to(...) (mockReturnValue returns the same
// object each call).
function emitMock(io) {
  return io.to.mock.results[0].value.emit;
}

beforeEach(() => {
  jest.resetModules();
  mockQuery.mockReset();
  defs = [];
  seededProgressRows = [];
  userProgressRows = [];
  flushCalls = [];

  mockQuery.mockImplementation((sql, params) => {
    if (sql.startsWith('SELECT * FROM challenge_definitions')) {
      return Promise.resolve({ rows: defs });
    }
    if (sql.startsWith('SELECT user_id, challenge_id, progress')) {
      return Promise.resolve({ rows: seededProgressRows });
    }
    if (sql.startsWith('SELECT cd.*')) {
      return Promise.resolve({ rows: userProgressRows });
    }
    if (sql.startsWith('INSERT INTO user_challenge_progress')) {
      flushCalls.push({ sql, params });
      return Promise.resolve({ rows: [] });
    }
    return Promise.resolve({ rows: [] });
  });

  // Re-require so each test starts with a fresh module-level cache
  ChallengeTracker = require('../ChallengeTracker');
});

afterEach(() => {
  ChallengeTracker.shutdown();
});

describe('ChallengeTracker', () => {
  describe('cache seeding on init (server restart)', () => {
    test('does NOT re-announce a challenge completed before the restart', async () => {
      defs = handsWonDefs();
      seededProgressRows = [
        { user_id: 'u1', challenge_id: 1, progress: 1, is_completed: true },
      ];
      const io = makeIo();
      await ChallengeTracker.init(io, new Map([['u1', 'socket-1']]));

      // The user wins another hand after the restart.
      ChallengeTracker.trackStat('u1', 'handsWon', 1);

      expect(io.to).not.toHaveBeenCalled();
    });

    test('keeps progress and completion state after the restart', async () => {
      defs = handsWonDefs();
      seededProgressRows = [
        { user_id: 'u1', challenge_id: 1, progress: 1, is_completed: true },
        { user_id: 'u1', challenge_id: 2, progress: 4, is_completed: false },
      ];
      userProgressRows = [
        { id: 1, stat: 'handsWon', name: 'First Blood', description: 'Win your first hand', target_value: 1, progress: 1, is_completed: true, completed_at: '2026-08-01T00:00:00Z' },
        { id: 2, stat: 'handsWon', name: 'Double Digits', description: 'Win 10 hands', target_value: 10, progress: 4, is_completed: false, completed_at: null },
      ];
      const io = makeIo();
      await ChallengeTracker.init(io, new Map([['u1', 'socket-1']]));

      ChallengeTracker.trackStat('u1', 'handsWon', 1); // 4 -> 5 toward Double Digits

      // Nothing newly completed → no toast, and the completed row is not re-flushed.
      expect(io.to).not.toHaveBeenCalled();

      await ChallengeTracker.shutdown(); // flush pending progress

      // First Blood (already complete) must NOT be re-flushed at all.
      expect(flushCalls.filter(c => c.params[1] === 1)).toHaveLength(0);
      // Double Digits advances 4 -> 5, still incomplete.
      const doubleDigitsFlush = flushCalls.filter(c => c.params[1] === 2);
      expect(doubleDigitsFlush).toHaveLength(1);
      expect(doubleDigitsFlush[0].params[2]).toBe(5); // progress
      expect(doubleDigitsFlush[0].params[3]).toBe(false); // is_completed
    });

    test('getUserProgress does NOT clobber unflushed (dirty) progress', async () => {
      defs = handsWonDefs();
      seededProgressRows = [
        { user_id: 'u1', challenge_id: 1, progress: 1, is_completed: true },
        { user_id: 'u1', challenge_id: 2, progress: 4, is_completed: false },
      ];
      // Stale DB snapshot: still shows 4 even though trackStat bumped it to 5.
      userProgressRows = [
        { id: 1, stat: 'handsWon', name: 'First Blood', description: 'Win your first hand', target_value: 1, progress: 1, is_completed: true, completed_at: '2026-08-01T00:00:00Z' },
        { id: 2, stat: 'handsWon', name: 'Double Digits', description: 'Win 10 hands', target_value: 10, progress: 4, is_completed: false, completed_at: null },
      ];
      const io = makeIo();
      await ChallengeTracker.init(io, new Map([['u1', 'socket-1']]));

      ChallengeTracker.trackStat('u1', 'handsWon', 1); // 4 -> 5 (dirty, not yet flushed)
      await ChallengeTracker.getUserProgress('u1');    // stale DB view must NOT overwrite it
      expect(io.to).not.toHaveBeenCalled();

      await ChallengeTracker.shutdown(); // flush pending progress

      const doubleDigitsFlush = flushCalls.filter(c => c.params[1] === 2);
      expect(doubleDigitsFlush).toHaveLength(1);
      expect(doubleDigitsFlush[0].params[2]).toBe(5); // cache kept the bumped value
      expect(doubleDigitsFlush[0].params[3]).toBe(false);
    });
  });

  describe('fresh completions', () => {
    test('announces exactly once on the first completion, never again', async () => {
      defs = handsWonDefs();
      const io = makeIo();
      await ChallengeTracker.init(io, new Map([['u1', 'socket-1']]));

      ChallengeTracker.trackStat('u1', 'handsWon', 1);
      ChallengeTracker.trackStat('u1', 'handsWon', 1);

      expect(io.to).toHaveBeenCalledTimes(1);
      expect(io.to).toHaveBeenCalledWith('socket-1');
      expect(emitMock(io)).toHaveBeenCalledWith('challenge_completed', expect.objectContaining({
        challengeId: 1,
        name: 'First Blood',
        stat: 'handsWon',
      }));
    });

    test('only announces milestones actually reached (not higher ones)', async () => {
      defs = handsWonDefs();
      const io = makeIo();
      await ChallengeTracker.init(io, new Map([['u1', 'socket-1']]));

      ChallengeTracker.trackStat('u1', 'handsWon', 1); // completes First Blood (1/1) only

      expect(io.to).toHaveBeenCalledTimes(1);
      expect(emitMock(io).mock.calls[0][1].challengeId).toBe(1);
    });
  });
});
