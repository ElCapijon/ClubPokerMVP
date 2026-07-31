// ============================================================
// HandStats.js - Lifetime hand tracker for logged-in players
//
// Aggregates per-user poker statistics (hands played, blinds
// paid, net profit, action counts, best hand, etc.) in an
// in-memory cache with a batched DB flush — never blocks the
// game loop.
// ============================================================

const db = require('./db');

// ─── In-Memory Cache ──────────────────────────────────────
// Map<userId, statsObject> — statsObject uses DB column names
// as keys so flush is a straight copy.
const statsCache = new Map();

// Batch flush interval handle
let flushIntervalHandle = null;

const STAT_FIELDS = [
  'hands_played',
  'hands_won',
  'blinds_paid',
  'total_wagered',
  'net_profit',
  'folds',
  'calls',
  'raises',
  'checks',
  'all_ins',
  'flops_seen',
  'showdowns_reached',
  'showdowns_won',
  'biggest_pot_won',
  'best_hand_rank',
  'best_hand_name',
];

function emptyStats() {
  const s = {};
  for (const f of STAT_FIELDS) s[f] = 0;
  s.best_hand_name = null;
  s.dirty = false;
  return s;
}

function isHumanUserId(userId) {
  return userId && !String(userId).startsWith('bot_');
}

// ─── Initialization ───────────────────────────────────────

/** Start the periodic batch flush (15s, same cadence as ChallengeTracker). */
function init() {
  flushIntervalHandle = setInterval(() => flushAll(), 15000);
  console.log('[HandStats] Tracker initialized with 15s batch flush interval');
}

/** Flush remaining stats on shutdown. */
function shutdown() {
  if (flushIntervalHandle) {
    clearInterval(flushIntervalHandle);
    flushIntervalHandle = null;
  }
  flushAll();
}

// ─── Core Tracking ────────────────────────────────────────

/**
 * Increment a numeric stat for a user. Ignores bots.
 * @param {string} userId
 * @param {string} field - DB column name, e.g. 'hands_played'
 * @param {number} [amount=1]
 */
function trackStat(userId, field, amount = 1) {
  if (!isHumanUserId(userId) || !STAT_FIELDS.includes(field) || amount === 0) return;
  if (!statsCache.has(userId)) statsCache.set(userId, emptyStats());
  const s = statsCache.get(userId);
  s[field] = (s[field] || 0) + amount;
  s.dirty = true;
}

/**
 * Record a completed hand's per-player stats.
 * @param {string} userId
 * @param {Object} data - { won, wagered, blindsPaid, bestRank, bestName, biggestPot, flopsSeen, showdown, wonShowdown }
 */
function trackHand(userId, data) {
  if (!isHumanUserId(userId)) return;
  if (!statsCache.has(userId)) statsCache.set(userId, emptyStats());
  const s = statsCache.get(userId);

  s.hands_played += 1;
  s.blinds_paid += data.blindsPaid || 0;
  s.total_wagered += data.wagered || 0;
  s.net_profit += (data.won || 0) - (data.wagered || 0);
  if (data.flopsSeen) s.flops_seen += 1;
  if (data.showdown) s.showdowns_reached += 1;

  if (data.won > 0) {
    s.hands_won += 1;
    if (data.wonShowdown) s.showdowns_won += 1;
    if ((data.biggestPot || 0) > s.biggest_pot_won) s.biggest_pot_won = data.biggestPot;
  }

  if (data.bestRank && data.bestRank > s.best_hand_rank) {
    s.best_hand_rank = data.bestRank;
    s.best_hand_name = data.bestName || null;
  }

  s.dirty = true;
}

// ─── Batch Database Flush ─────────────────────────────────

async function flushUser(userId) {
  const s = statsCache.get(userId);
  if (!s || !s.dirty) return;

  // Snapshot the values being flushed so that any new increments arriving
  // while the query is in flight are preserved in the cache below.
  const flushed = {};
  for (const f of STAT_FIELDS) flushed[f] = s[f];

  try {
    await db.query(
      `INSERT INTO player_hand_stats (
         user_id, hands_played, hands_won, blinds_paid, total_wagered, net_profit,
         folds, calls, raises, checks, all_ins, flops_seen, showdowns_reached,
         showdowns_won, biggest_pot_won, best_hand_rank, best_hand_name, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         hands_played = player_hand_stats.hands_played + EXCLUDED.hands_played,
         hands_won = player_hand_stats.hands_won + EXCLUDED.hands_won,
         blinds_paid = player_hand_stats.blinds_paid + EXCLUDED.blinds_paid,
         total_wagered = player_hand_stats.total_wagered + EXCLUDED.total_wagered,
         net_profit = player_hand_stats.net_profit + EXCLUDED.net_profit,
         folds = player_hand_stats.folds + EXCLUDED.folds,
         calls = player_hand_stats.calls + EXCLUDED.calls,
         raises = player_hand_stats.raises + EXCLUDED.raises,
         checks = player_hand_stats.checks + EXCLUDED.checks,
         all_ins = player_hand_stats.all_ins + EXCLUDED.all_ins,
         flops_seen = player_hand_stats.flops_seen + EXCLUDED.flops_seen,
         showdowns_reached = player_hand_stats.showdowns_reached + EXCLUDED.showdowns_reached,
         showdowns_won = player_hand_stats.showdowns_won + EXCLUDED.showdowns_won,
         biggest_pot_won = GREATEST(player_hand_stats.biggest_pot_won, EXCLUDED.biggest_pot_won),
         best_hand_rank = GREATEST(player_hand_stats.best_hand_rank, EXCLUDED.best_hand_rank),
         best_hand_name = CASE WHEN EXCLUDED.best_hand_rank >= player_hand_stats.best_hand_rank
           THEN EXCLUDED.best_hand_name ELSE player_hand_stats.best_hand_name END,
         updated_at = NOW()`,
      [
        userId, flushed.hands_played, flushed.hands_won, flushed.blinds_paid,
        flushed.total_wagered, flushed.net_profit, flushed.folds, flushed.calls,
        flushed.raises, flushed.checks, flushed.all_ins, flushed.flops_seen,
        flushed.showdowns_reached, flushed.showdowns_won, flushed.biggest_pot_won,
        flushed.best_hand_rank, flushed.best_hand_name,
      ]
    );

    // Remove the flushed amounts from the cache, keeping any newer increments.
    // Max fields (biggest_pot_won, best_hand_rank) are persisted via GREATEST,
    // so reset them to 0 once flushed.
    for (const f of STAT_FIELDS) {
      if (f === 'best_hand_name') continue;
      if (f === 'biggest_pot_won' || f === 'best_hand_rank') {
        if ((s[f] || 0) <= (flushed[f] || 0)) {
          s[f] = 0;
          if (f === 'best_hand_rank') s.best_hand_name = null;
        }
      } else {
        s[f] = (s[f] || 0) - (flushed[f] || 0);
      }
    }
    s.dirty =
      STAT_FIELDS.some(f => f !== 'best_hand_name' && (s[f] || 0) !== 0) ||
      ((s.best_hand_name != null) && (s.best_hand_rank || 0) > 0);
  } catch (err) {
    console.error(`[HandStats] DB flush error for user ${userId}:`, err.message);
  }
}

async function flushAll() {
  const dirtyUsers = [];
  for (const [userId, s] of statsCache) {
    if (s.dirty) dirtyUsers.push(userId);
  }
  for (const userId of dirtyUsers) {
    await flushUser(userId);
  }
}

// ─── Queries ──────────────────────────────────────────────

/**
 * Get a user's lifetime hand stats (flushing pending first so
 * results are fresh). Returns null if the user has no stats yet.
 */
async function getUserStats(userId) {
  if (isHumanUserId(userId)) {
    await flushUser(userId);
  }
  const result = await db.query('SELECT * FROM player_hand_stats WHERE user_id = $1', [userId]);
  if (result.rows.length === 0) return null;
  return normalizeRow(result.rows[0]);
}

function normalizeRow(row) {
  return {
    handsPlayed: row.hands_played || 0,
    handsWon: row.hands_won || 0,
    blindsPaid: row.blinds_paid || 0,
    totalWagered: row.total_wagered || 0,
    netProfit: row.net_profit || 0,
    folds: row.folds || 0,
    calls: row.calls || 0,
    raises: row.raises || 0,
    checks: row.checks || 0,
    allIns: row.all_ins || 0,
    flopsSeen: row.flops_seen || 0,
    showdownsReached: row.showdowns_reached || 0,
    showdownsWon: row.showdowns_won || 0,
    biggestPotWon: row.biggest_pot_won || 0,
    bestHandRank: row.best_hand_rank || 0,
    bestHandName: row.best_hand_name || 'High Card',
  };
}

module.exports = {
  init,
  shutdown,
  trackStat,
  trackHand,
  getUserStats,
};
